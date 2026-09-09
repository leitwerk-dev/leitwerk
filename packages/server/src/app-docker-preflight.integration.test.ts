import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import {
	automaticTurn,
	type Codec,
	defineProcess,
	type LeitwerkExtensionModule,
} from "@leitwerk-dev/process-sdk";
import { postImmediateLaunch } from "@leitwerk-dev/test-support";
import {
	createIntegrationHarness,
	type IntegrationHarness,
} from "@leitwerk-dev/test-support/integration";
import { createInProcessWorkerSpawn } from "@leitwerk-dev/test-support/worker-testing";
import { afterEach, describe, expect, it, vi } from "vitest";

const emptyCodec: Codec<Record<string, never>> = {
	parse: () => ({}),
	serialize: (value) => value,
};

const dockerProcess = defineProcess<Record<string, never>, Record<string, never>>({
	id: "docker_preflight_test",
	displayName: "Docker preflight test",
	runtime: { docker: true },
	entry: "finish",
	paramsCodec: emptyCodec,
	stateCodec: emptyCodec,
	initialState: () => ({}),
	turns: {
		finish: automaticTurn({
			description: "Complete after worker startup",
			run: async () => ({ outcome: "done", params: {} }),
			outcomes: { done: { description: "Done", parameters: {}, complete: true } },
		}),
	},
	launchers(api) {
		api.launcher({
			id: "docker_preflight_test.ui",
			label: "Docker preflight test",
			description: "Launch a Docker-requiring worker",
			visibility: "ui",
			ui: {
				card: {},
				launchConfigSchema: { id: "docker_preflight_test", fields: [] },
				resolveLaunchConfig: () => ({
					ok: true,
					launchConfig: {
						processId: "docker_preflight_test",
						params: {},
						startTurnId: "finish",
					},
				}),
			},
		});
	},
});

const extension: LeitwerkExtensionModule = {
	manifest: { id: "docker-preflight-test", version: "0.1.0" },
	setupCatalog: (api) => api.registerProcess(dockerProcess),
};

let harness: IntegrationHarness | undefined;
let root: string | undefined;

afterEach(async () => {
	try {
		await harness?.ctx.app.close();
	} finally {
		harness = undefined;
		if (root) await rm(root, { recursive: true, force: true });
		root = undefined;
	}
});

async function setup(preflight: (timeoutMs: number) => Promise<void>, allowHostDocker = true) {
	const directory = await mkdtemp(join(tmpdir(), "leitwerk-app-docker-preflight-"));
	root = directory;
	const extensionCatalog = await buildExtensionCatalogFromModules([extension]);
	const spawn = vi.fn(createInProcessWorkerSpawn({ extensionCatalog }));
	const app = await createIntegrationHarness({
		extensionCatalog,
		appOverrides: {
			localWorkerDockerPreflightImpl: preflight,
			localWorkerSpawnImpl: spawn,
		},
		configOverride(config) {
			config.storage.sqlite_path = ":memory:";
			config.storage.process_workspaces_dir = join(directory, "workspaces");
			config.storage.tree_files_dir = join(directory, "trees");
			config.pi.agent_dir = join(directory, "pi-agent");
			config.workers.startup_timeout = "5s";
			config.workers.shutdown_grace_period = "100ms";
			config.local_worker = { ...config.local_worker, allow_host_docker: allowHostDocker };
		},
	});
	harness = app;
	return {
		...app,
		spawn,
		launch: () => postImmediateLaunch(app.address, "docker_preflight_test.ui", {}),
	};
}

describe("application local Docker preflight wiring", () => {
	it("uses the injected probe for admission and worker startup", async () => {
		const preflight = vi.fn(async (_timeoutMs: number) => {});
		const app = await setup(preflight);
		const response = await app.launch();
		const body = await response.json();
		expect(response.status).toBe(201);
		await vi.waitFor(
			() => {
				expect(app.ctx.deps.processes.getById(body.process.id)?.lifecycleStatus).toBe("completed");
			},
			{ timeout: 5_000 },
		);
		expect(preflight).toHaveBeenCalledTimes(2);
		expect(preflight).toHaveBeenNthCalledWith(1, 5_000);
		expect(preflight.mock.calls[1]?.[0]).toBeGreaterThan(0);
		expect(preflight.mock.calls[1]?.[0]).toBeLessThanOrEqual(5_000);
		expect(app.spawn).toHaveBeenCalledOnce();
	});

	it("rejects admission without creating a process when the injected probe fails", async () => {
		const preflight = vi.fn().mockRejectedValue(new Error("Docker unavailable"));
		const app = await setup(preflight);
		const response = await app.launch();
		expect(response.status).toBe(400);
		const body = await response.json();
		expect(app.ctx.deps.launchRuns.getById(body.launchRunId)).toMatchObject({
			status: "failed",
			instanceId: null,
		});
		expect(app.ctx.deps.processes.listAll()).toEqual([]);
		expect(preflight).toHaveBeenCalledOnce();
		expect(app.spawn).not.toHaveBeenCalled();
	});

	it("retains the admitted process in error when the startup probe fails", async () => {
		const preflight = vi
			.fn()
			.mockResolvedValueOnce(undefined)
			.mockRejectedValue(new Error("Docker became unavailable"));
		const app = await setup(preflight);
		const response = await app.launch();
		const body = await response.json();
		expect(body.process.id).toBeTruthy();
		await vi.waitFor(() => {
			expect(app.ctx.deps.processes.getById(body.process.id)?.lifecycleStatus).toBe("error");
		});
		expect(app.ctx.deps.processes.listAll()).toHaveLength(1);
		expect(preflight).toHaveBeenCalledTimes(2);
		expect(app.spawn).not.toHaveBeenCalled();
	});

	it("still requires host Docker opt-in before probing or creating a process", async () => {
		const preflight = vi.fn(async (_timeoutMs: number) => {});
		const app = await setup(preflight, false);
		const response = await app.launch();
		expect(response.status).toBe(400);
		const body = await response.json();
		expect(app.ctx.deps.launchRuns.getById(body.launchRunId)).toMatchObject({
			status: "failed",
			instanceId: null,
		});
		expect(app.ctx.deps.processes.listAll()).toEqual([]);
		expect(preflight).not.toHaveBeenCalled();
		expect(app.spawn).not.toHaveBeenCalled();
	});
});
