import { existsSync, readFileSync, statSync } from "node:fs";
import type { ResolvedWorkerProcess } from "@leitwerk-dev/extension-runtime";
import type { WorkerStartPayload } from "@leitwerk-dev/worker-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { MiseDevelopmentToolEnvironment } from "../development-tool-environment.js";
import { DockerRegistryCredentials } from "../docker-registry-credentials.js";
import type { PiTreeHandleFactory } from "../pi-adapter.js";
import type { RunRootGitOps } from "../workspace/run-root.js";
import { WorkerLiveResources } from "./bootstrap-session.js";
import { extractSecretValuesFromPayload, redactSecrets } from "./failure-policy.js";
import { nodeWorkerRuntimeScheduler } from "./index.js";
import type { WorkerRuntimeSettings } from "./settings.js";

const credential = {
	registry: "registry.example",
	username: "devuser",
	password: "test-secret/password",
};
const store = new DockerRegistryCredentials();
afterEach(() => store.dispose());
describe("ephemeral Docker credentials", () => {
	it("writes restrictive credentials outside retained storage, replaces them, and cleans up", () => {
		const previous = process.env.DOCKER_CONFIG;
		store.install([credential], true);
		const first = process.env.DOCKER_CONFIG ?? "";
		expect(process.env.BUILDX_CONFIG).toBeDefined();
		expect(process.env.BUILDX_CONFIG?.startsWith(first)).toBe(false);
		expect(first).toMatch(/^\/tmp\/leitwerk-docker-auth-/);
		expect(statSync(first).mode & 0o777).toBe(0o700);
		expect(statSync(`${first}/config.json`).mode & 0o777).toBe(0o600);
		const auth = JSON.parse(readFileSync(`${first}/config.json`, "utf8")).auths[credential.registry]
			.auth;
		expect(Buffer.from(auth, "base64").toString()).toBe(
			`${credential.username}:${credential.password}`,
		);
		store.install([{ ...credential, password: "changed" }], true);
		expect(existsSync(first)).toBe(false);
		const second = process.env.DOCKER_CONFIG ?? "";
		expect(second).not.toBe(first);
		expect(readFileSync(`${second}/config.json`, "utf8")).not.toContain(auth);
		store.dispose();
		expect(existsSync(second)).toBe(false);
		expect(process.env.DOCKER_CONFIG).toBe(previous);
	});
	it("rejects unsolicited or duplicate credentials without retaining files", () => {
		expect(() => store.install([credential], false)).toThrow("Docker-enabled");
		store.install([credential], true);
		const directory = process.env.DOCKER_CONFIG ?? "";
		expect(() => store.install([credential, credential], true)).toThrow("Duplicate");
		expect(existsSync(directory)).toBe(false);
	});
	it("redacts raw, URL-encoded and Docker auth values", () => {
		const payload = {
			bootstrap: { kind: "automatic" },
			dockerRegistryCredentials: [credential],
		} as WorkerStartPayload;
		const secrets = extractSecretValuesFromPayload(payload);
		const values = [
			credential.password,
			Buffer.from(`${credential.username}:${credential.password}`).toString("base64"),
			Buffer.from(credential.password).toString("base64"),
			encodeURIComponent(credential.password),
		];
		expect(redactSecrets(values.join(" "), secrets)).toBe(values.map(() => "<redacted>").join(" "));
	});
});

it("removes credential files when later bootstrap work fails", async () => {
	let directory: string | undefined;
	const resources = new WorkerLiveResources({
		instanceId: "test",
		piFactory: {} as PiTreeHandleFactory,
		gitOps: {
			configureRepositoryCredentials() {
				directory = process.env.DOCKER_CONFIG;
				throw new Error("bootstrap fixture failure");
			},
		} as unknown as RunRootGitOps,
		scheduler: nodeWorkerRuntimeScheduler,
		developmentTools: new MiseDevelopmentToolEnvironment(),
		resolveWorkerProcess: () => ({ runtime: { docker: true } }) as ResolvedWorkerProcess,
		progress() {},
		diagnosticTrace() {},
	});
	const previous = process.env.DOCKER_CONFIG;
	await expect(
		resources.bootstrap(
			{
				bootstrap: { kind: "automatic" },
				processSnapshot: { processId: "test" },
				projectSnapshots: [],
				dockerRegistryCredentials: [credential],
			} as unknown as WorkerStartPayload,
			{} as WorkerRuntimeSettings,
		),
	).rejects.toThrow("bootstrap fixture failure");
	expect(directory).toBeDefined();
	expect(existsSync(directory ?? "")).toBe(false);
	expect(process.env.DOCKER_CONFIG).toBe(previous);
});
