import type { ExtensionProcessDefinition } from "@leitwerk-dev/process-sdk";
import { describe, expect, it } from "vitest";
import { getDefaultConfig } from "./config/config-loader.js";
import { isValidStorageSize, resolveProcessStorageSize } from "./process-storage-size.js";
import { createFixtureProcess } from "./test-helpers/process-fixtures.js";

function setup() {
	const config = getDefaultConfig();
	config.workers.runner = "kubernetes";
	const definition: ExtensionProcessDefinition = createFixtureProcess({
		id: "storage_process",
		entry: "start",
	});
	definition.paramsCodec = { ...definition.paramsCodec };
	return {
		config,
		definition,
		process: { processId: definition.id, paramsJson: null },
		projects: [],
	};
}

describe("storage quantities", () => {
	it.each([
		"128Mi",
		"1Gi",
		"50Gi",
		"1.5Gi",
		"1G",
		"1024",
		"1e9",
		".5Gi",
		"1Ei",
		"1E",
	])("accepts %s", (value) => expect(isValidStorageSize(value)).toBe(true));

	it.each([
		"",
		" ",
		" 1Gi",
		"1Gi\n",
		"0",
		"0Gi",
		"-1Gi",
		"1GB",
		"large",
		"NaN",
		"1e999",
		null,
		128,
	])("rejects %s", (value) => expect(isValidStorageSize(value)).toBe(false));
});

describe("resolveProcessStorageSize", () => {
	it("uses the global default when no override or resolver is declared", () => {
		const input = setup();
		expect(resolveProcessStorageSize(input)).toBe("20Gi");
		expect(resolveProcessStorageSize({ ...input, definition: undefined })).toBe("20Gi");
	});

	it("uses an explicit process override without calling the resolver or params codec", () => {
		const input = setup();
		input.config.process_configs = { storage_process: { storage_size: "128Mi", turn_configs: {} } };
		input.definition.paramsCodec.parse = () => {
			throw new Error("must not parse");
		};
		input.definition.resolveStorageSize = () => {
			throw new Error("must not resolve");
		};
		expect(resolveProcessStorageSize(input)).toBe("128Mi");
	});

	it.each([
		['{"profile":"team"}', { profile: "team" }],
		[null, undefined],
	])("passes codec-validated params and projects for stored params %s", (paramsJson, rawParams) => {
		const input = setup();
		const process = { ...input.process, paramsJson };
		input.definition.paramsCodec.parse = (raw) => {
			expect(raw).toEqual(rawParams);
			return { profile: "validated-team" };
		};
		input.definition.resolveStorageSize = ({ params, projects }) => {
			expect(params).toEqual({ profile: "validated-team" });
			expect(projects).toBe(input.projects);
			return "50Gi";
		};
		expect(resolveProcessStorageSize({ ...input, process })).toBe("50Gi");
	});

	it("falls back to the configured global size when the extension returns undefined", () => {
		const input = setup();
		if (!input.config.kubernetes) throw new Error("Missing Kubernetes defaults");
		input.config.kubernetes.process_volume.size = "7Gi";
		input.definition.resolveStorageSize = () => undefined;
		expect(resolveProcessStorageSize(input)).toBe("7Gi");
	});

	it.each([
		"",
		"0Gi",
		"-1Gi",
		"1GB",
	])("rejects invalid extension size %s instead of falling back", (size) => {
		const input = setup();
		input.definition.resolveStorageSize = () => size;
		expect(() => resolveProcessStorageSize(input)).toThrow("Worker runtime start failed");
	});

	it("does not hide extension failures", () => {
		const input = setup();
		input.definition.resolveStorageSize = () => {
			throw new Error("Repository settings unavailable");
		};
		expect(() => resolveProcessStorageSize(input)).toThrow("Repository settings unavailable");
	});

	it.each([
		"local",
		"docker",
	] as const)("does not resolve unused capacity for %s workers", (runner) => {
		const input = setup();
		input.config.workers.runner = runner;
		input.definition.resolveStorageSize = () => {
			throw new Error("must not resolve");
		};
		expect(resolveProcessStorageSize(input)).toBeUndefined();
	});
});
