import { describe, expect, it } from "vitest";
import {
	getDefaultConfig,
	sanitizeConfigForLogging,
	validateConfig,
} from "./config/config-loader.js";
import { resolveDockerRegistryCredentials } from "./docker-registry-credentials.js";
import { buildWorkerConfigSnapshot } from "./supervisor/worker-start-payload-builder.js";

const credential = {
	registry: "registry.example",
	username: "devuser",
	password: "private-registry-test-password",
};
function config() {
	return {
		...getDefaultConfig(),
		docker_registries: {
			profiles: { approved: { ...credential }, admin: { ...credential, password: "other-secret" } },
			process_bindings: { fixer: ["approved"] },
		},
	};
}
describe("server-owned Docker credentials", () => {
	it("delivers only bound profiles to Docker-enabled processes and resolves rotation afresh", () => {
		const source = config();
		expect(resolveDockerRegistryCredentials(source, "fixer", false)).toEqual([]);
		expect(resolveDockerRegistryCredentials(source, "unbound", true)).toEqual([]);
		const first = resolveDockerRegistryCredentials(source, "fixer", true);
		expect(first).toEqual([credential]);
		source.docker_registries.profiles.approved.password = "rotated-secret";
		expect(resolveDockerRegistryCredentials(source, "fixer", true)[0]?.password).toBe(
			"rotated-secret",
		);
		expect(first[0]?.password).toBe(credential.password);
	});
	it("rejects unknown profile bindings and duplicate registry credentials", () => {
		const source = config();
		for (const binding of [["missing"], ["approved", "admin"], ["approved", "approved"]]) {
			source.docker_registries.process_bindings.fixer = binding;
			expect(validateConfig(source)).toContain(
				"docker_registries.process_bindings contains an unknown profile or duplicate registry",
			);
			expect(() => resolveDockerRegistryCredentials(source, "fixer", true)).toThrow();
		}
	});
	it("keeps credentials out of config snapshots and startup diagnostics", () => {
		const source = config();
		expect(validateConfig(source)).toEqual([]);
		expect(JSON.stringify(buildWorkerConfigSnapshot(source))).not.toContain("docker_registries");
		expect(JSON.stringify(sanitizeConfigForLogging(source))).not.toContain(credential.password);
		expect(JSON.stringify(sanitizeConfigForLogging(source))).not.toContain("other-secret");
		source.docker_registries.profiles.approved.registry = "https://registry.example/repository";
		expect(validateConfig(source).length).toBeGreaterThan(0);
	});
});
