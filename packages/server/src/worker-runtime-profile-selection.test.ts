import { describe, expect, it } from "vitest";
import { getDefaultConfig } from "./config/config-loader.js";
import type { WorkerRuntimeProfileConfig } from "./config/config-types.js";
import {
	buildRuntimeProfileSelectionInput,
	selectWorkerRuntimeProfile,
} from "./worker-runtime-profile-selection.js";

const profiles: Record<string, WorkerRuntimeProfileConfig> = {
	generic: { image: "ghcr.io/example/generic:1" },
	node22: { image: "ghcr.io/example/node22:1" },
	java21: { image: "ghcr.io/example/java21:1" },
};

describe("selectWorkerRuntimeProfile", () => {
	it("prefers the process-level override over component profiles", () => {
		const result = selectWorkerRuntimeProfile({
			processId: "p",
			processOverride: "java21",
			componentProfiles: [{ component: "frontend", profile: "node22" }],
			defaultProfile: "generic",
			profiles,
		});
		expect(result).toEqual({
			ok: true,
			runtimeProfile: "java21",
			image: { reference: "ghcr.io/example/java21:1" },
		});
	});

	it("uses a single agreeing component profile", () => {
		const result = selectWorkerRuntimeProfile({
			processId: "p",
			componentProfiles: [
				{ component: "frontend", profile: "node22" },
				{ component: "frontend-tests", profile: "node22" },
			],
			defaultProfile: "generic",
			profiles,
		});
		expect(result).toMatchObject({ ok: true, runtimeProfile: "node22" });
	});

	it("falls back to the default when no component declares a profile", () => {
		const result = selectWorkerRuntimeProfile({
			processId: "p",
			componentProfiles: [{ component: "frontend" }, { component: "backend" }],
			defaultProfile: "generic",
			profiles,
		});
		expect(result).toMatchObject({ ok: true, runtimeProfile: "generic" });
	});

	it("rejects conflicting component profiles without an override", () => {
		const result = selectWorkerRuntimeProfile({
			processId: "implement_ticket_issue_process",
			componentProfiles: [
				{ component: "frontend", profile: "node22" },
				{ component: "backend", profile: "java21" },
			],
			defaultProfile: "generic",
			profiles,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("conflicting component worker runtime profiles");
			expect(result.error).toContain("backend=java21");
			expect(result.error).toContain("frontend=node22");
		}
	});

	it("rejects when no profile is selected and no default is configured", () => {
		const result = selectWorkerRuntimeProfile({
			processId: "p",
			componentProfiles: [{ component: "frontend" }],
			profiles,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("no default worker runtime profile is configured");
		}
	});

	it("rejects a reference to an unknown profile", () => {
		const result = selectWorkerRuntimeProfile({
			processId: "p",
			processOverride: "does-not-exist",
			componentProfiles: [],
			defaultProfile: "generic",
			profiles,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("Unknown worker runtime profile 'does-not-exist'");
		}
	});

	it("treats blank profile strings as unset", () => {
		const result = selectWorkerRuntimeProfile({
			processId: "p",
			processOverride: "   ",
			componentProfiles: [{ component: "frontend", profile: "" }],
			defaultProfile: "generic",
			profiles,
		});
		expect(result).toMatchObject({ ok: true, runtimeProfile: "generic" });
	});
});

describe("buildRuntimeProfileSelectionInput", () => {
	it("reads override, component, and default selections from config", () => {
		const config = getDefaultConfig();
		config.workers.default_runtime_profile = "generic";
		config.worker_runtime_profiles = profiles;
		config.components = {
			frontend: { repo: "git@x:fe.git", default_branch: "main", worker_runtime_profile: "node22" },
			backend: { repo: "git@x:be.git", default_branch: "main" },
		};
		config.process_configs = {
			my_process: { turn_configs: {}, worker_runtime_profile: "java21" },
		};

		const input = buildRuntimeProfileSelectionInput({
			config,
			processId: "my_process",
			componentKeys: ["frontend", "backend"],
		});

		expect(input.processOverride).toBe("java21");
		expect(input.defaultProfile).toBe("generic");
		expect(input.componentProfiles).toEqual([
			{ component: "frontend", profile: "node22" },
			{ component: "backend", profile: undefined },
		]);

		const selected = selectWorkerRuntimeProfile(input);
		expect(selected).toMatchObject({ ok: true, runtimeProfile: "java21" });
	});

	it("uses kubernetes.default_worker_runtime_profile ahead of the shared worker default in Kubernetes mode", () => {
		const config = getDefaultConfig();
		config.workers.runner = "kubernetes";
		config.workers.default_runtime_profile = "generic";
		if (config.kubernetes) {
			config.kubernetes.default_worker_runtime_profile = "node22";
		}
		config.worker_runtime_profiles = profiles;

		const input = buildRuntimeProfileSelectionInput({
			config,
			processId: "my_process",
			componentKeys: [],
		});

		expect(input.defaultProfile).toBe("node22");
		expect(selectWorkerRuntimeProfile(input)).toMatchObject({ ok: true, runtimeProfile: "node22" });
	});
});
