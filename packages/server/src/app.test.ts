import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import { coreHostCapabilities } from "@leitwerk-dev/process-sdk";
import { emptyPollResult } from "@leitwerk-dev/watcher-utils";
import { describe, expect, it, vi } from "vitest";
import { type AppContext, type AppOptions, createAppContext } from "./app.js";
import { getDefaultConfig } from "./config/index.js";
import {
	createFixtureAutomaticTurn,
	createFixtureProcess,
} from "./test-helpers/process-fixtures.js";
import { fakeWorkerRunnerRuntime } from "./test-helpers/worker-runner-runtime.js";

function createLocalApp(options: Partial<AppOptions> = {}, maxParallelProcesses?: number) {
	const config = getDefaultConfig();
	config.storage.sqlite_path = ":memory:";
	config.workers.runner = "local";
	if (maxParallelProcesses !== undefined)
		config.workers.max_parallel_processes = maxParallelProcesses;
	return createAppContext({
		config,
		logger: false,
		extensionCatalog: buildExtensionCatalogFromModules([]),
		workerRunnerRuntime: fakeWorkerRunnerRuntime(),
		...options,
	});
}

function prepareAutomaticStart(ctx: AppContext, instanceId: string) {
	const start = ctx.deps.turnStarts.create({
		instanceId,
		turnId: "work",
		turnType: "automatic",
		proposedTurnRecordId: `trn_${instanceId}`,
		startKind: "selected_turn",
		recoveryTurnRecordId: null,
		continuation: null,
		state: { kind: "starting", start: { kind: "automatic" } },
	});
	ctx.deps.processes.update(instanceId, {
		selectedTurnId: "work",
		currentExecution: { kind: "worker_start", id: start.id },
	});
}

describe("createAppContext", () => {
	it("queues capacity overflow without a lease and starts it after a worker exits", async () => {
		const runtime = fakeWorkerRunnerRuntime();
		const exits = new Map<string, () => void>();
		vi.mocked(runtime.runner.start).mockImplementation(async (input) => ({
			instanceId: input.instanceId,
			workerId: input.workerId,
			unitId: input.workerId,
			onExit(listener) {
				exits.set(input.instanceId, () => listener({ exitCode: 0, signal: null }));
			},
		}));
		vi.mocked(runtime.runner.stop).mockImplementation(async (ref) => {
			const notify = exits.get(ref.instanceId);
			exits.delete(ref.instanceId);
			notify?.();
		});
		const ctx = await createLocalApp(
			{
				extensionCatalog: buildExtensionCatalogFromModules([
					{
						manifest: { id: "capacity-test", version: "0.1.0" },
						setupCatalog(api) {
							api.registerProcess(
								createFixtureProcess({
									id: "test_process",
									entry: "work",
									turns: { work: createFixtureAutomaticTurn() },
								}),
							);
						},
					},
				]),
				workerRunnerRuntime: runtime,
			},
			1,
		);
		try {
			const processes = [0, 1, 2].map(() => {
				const process = ctx.deps.processes.create({
					processId: "test_process",
					lifecycleStatus: "active",
					selectedTurnId: "work",
				});
				prepareAutomaticStart(ctx, process.id);
				return process;
			});
			await ctx.supervisor.spawnWorker(processes[0].id);
			expect(await ctx.supervisor.spawnWorker(processes[1].id)).toBeUndefined();
			await ctx.supervisor.spawnWorker(processes[2].id);
			expect(ctx.deps.leases.getByInstance(processes[1].id)).toBeNull();
			expect(ctx.deps.events.listByInstance(processes[1].id)).toContainEqual(
				expect.objectContaining({ eventType: "worker_capacity_queued" }),
			);
			expect(ctx.deps.turnRecords.listByInstance(processes[1].id)).toEqual([]);
			const snapshot = await ctx.app.inject({
				method: "GET",
				url: `/api/processes/${processes[1].id}/ui-snapshot`,
			});
			expect(snapshot.statusCode, snapshot.body).toBe(200);
			expect(snapshot.json().startup.attempts[0].steps[0].label).toBe(
				"Waiting for worker capacity",
			);
			// Cancellation remains possible while the queue is full.
			ctx.deps.processes.update(processes[1].id, { lifecycleStatus: "aborted" });
			await ctx.supervisor.stopWorker(processes[1].id, "operator");
			await ctx.supervisor.stopWorker(processes[0].id, "test_release");
			await vi.waitFor(() => expect(ctx.supervisor.getWorker(processes[2].id)).toBeDefined());
			expect(runtime.runner.start).toHaveBeenCalledTimes(2);
			expect(ctx.deps.leases.getByInstance(processes[1].id)).toBeNull();
		} finally {
			await ctx.app.close();
		}
	});

	it("blocks replacement of a stale runtime until background cleanup releases its process storage", async () => {
		const runtime = fakeWorkerRunnerRuntime();
		const cleanup = Promise.withResolvers<void>();
		vi.mocked(runtime.runner.stop).mockImplementation(() => cleanup.promise);
		const ctx = await createLocalApp({ workerRunnerRuntime: runtime });
		try {
			const process = ctx.deps.processes.create({ processId: "test_process" });
			const unrelated = ctx.deps.processes.create({ processId: "test_process" });
			for (const candidate of [process, unrelated]) {
				prepareAutomaticStart(ctx, candidate.id);
			}
			vi.mocked(runtime.runner.list).mockResolvedValue([
				{ instanceId: process.id, workerId: "stale-worker", unitId: "stale-container" },
			]);
			await ctx.supervisor.adoptRegisteredWorkers();
			await expect(ctx.supervisor.spawnWorker(process.id)).rejects.toThrow("still being removed");
			expect(runtime.runner.start).not.toHaveBeenCalled();
			expect(ctx.deps.leases.getByInstance(process.id)).toBeNull();

			// An unrelated process still reaches the runner while stale cleanup is pending.
			await expect(ctx.supervisor.spawnWorker(unrelated.id)).rejects.toThrow(
				"unexpected worker start",
			);
			expect(runtime.runner.start).toHaveBeenCalledTimes(1);

			cleanup.resolve();
			await new Promise<void>((resolve) => setImmediate(resolve));
			await expect(ctx.supervisor.spawnWorker(process.id)).rejects.toThrow(
				"unexpected worker start",
			);
			expect(runtime.runner.start).toHaveBeenCalledTimes(2);
		} finally {
			cleanup.resolve();
			await ctx.app.close();
		}
	});

	it("keeps raw project repos silent and emits project updates through the mutation service", async () => {
		const ctx = await createLocalApp();
		try {
			const frames: Array<Parameters<typeof ctx.broadcaster.broadcast>[0]> = [];
			ctx.broadcaster.broadcast = (frame) => {
				frames.push(frame);
			};
			const process = ctx.deps.processes.create({ processId: "demo_process" });
			const project = ctx.deps.projects.create({
				instanceId: process.id,
				key: "app",
				repoLocator: "https://example.com/app.git",
				baseBranch: "main",
				workBranch: "feature/demo",
			});

			ctx.deps.projects.update(project.id, { externalId: "42" });

			expect(frames.filter((frame) => frame.type === "project.updated")).toEqual([]);

			ctx.projectMutations.update(project.id, { externalId: "43" });

			const projectFrames = frames.filter((frame) => frame.type === "project.updated");
			expect(projectFrames.at(-1)).toMatchObject({
				instanceId: process.id,
				payload: {
					projectId: "app",
					project: {
						key: "app",
						externalId: "43",
						branch: "feature/demo",
					},
				},
			});
			expect(projectFrames.at(-1)?.payload).not.toHaveProperty("changedFields");
		} finally {
			await ctx.app.close();
		}
	});

	it("leaves watcher validation to registered extension sources", async () => {
		const config = getDefaultConfig();
		config.process_configs = {
			poem_creator_process: {
				turn_configs: {},
				watchers: {
					create_poem: {
						custom_source_field: "extension-owned",
					} as never,
				},
			},
		};

		const ctx = await createAppContext({
			config,
			extensionCatalog: buildExtensionCatalogFromModules([]),
		});
		await ctx.app.close();
	});

	it("reports readiness only after every start hook succeeds and clears it before stop hooks", async () => {
		const { promise: startGate, resolve: releaseStart } = Promise.withResolvers<void>();
		let readyDuringStop: boolean | undefined;
		let ctx: AppContext;
		const extensionCatalog = await buildExtensionCatalogFromModules([
			{
				manifest: { id: "readiness-test", version: "1.0.0" },
				setupServer(api) {
					api.onStart(() => startGate);
					api.onStop(() => {
						readyDuringStop = ctx.isReady();
					});
				},
			},
		]);
		ctx = await createLocalApp({ extensionCatalog });
		try {
			expect((await ctx.app.inject({ url: "/api/health" })).statusCode).toBe(200);
			expect((await ctx.app.inject({ url: "/api/ready" })).statusCode).toBe(503);

			const starting = ctx.startBackgroundServices();
			await Promise.resolve();
			expect((await ctx.app.inject({ url: "/api/ready" })).statusCode).toBe(503);
			releaseStart();
			await starting;
			expect((await ctx.app.inject({ url: "/api/ready" })).statusCode).toBe(200);

			await ctx.stopBackgroundServices();
			expect(readyDuringStop).toBe(false);
			expect((await ctx.app.inject({ url: "/api/ready" })).statusCode).toBe(503);
		} finally {
			releaseStart();
			await ctx.app.close();
		}
	});

	it("starts registered pollers after extension start hooks and stops them with the server", async () => {
		const events: string[] = [];
		const extensionCatalog = await buildExtensionCatalogFromModules([
			{
				manifest: { id: "polling-lifecycle-test", version: "1.0.0" },
				setupServer(api) {
					const deps = api.require(coreHostCapabilities.serverSetup);
					if (Array.isArray(deps)) throw new Error("expected one server setup capability");
					deps.polling.create({
						id: "lifecycle-test",
						isEnabled: () => true,
						pollInterval: () => "10ms",
						async pollOnce() {
							events.push("poll");
							return emptyPollResult();
						},
					});
					api.onStart(() => events.push("extension-start"));
				},
			},
		]);
		const ctx = await createLocalApp({ extensionCatalog });
		try {
			await ctx.startBackgroundServices();
			await vi.waitFor(() => expect(events).toContain("poll"));
			expect(events.slice(0, 2)).toEqual(["extension-start", "poll"]);

			await ctx.stopBackgroundServices();
			const countAfterStop = events.length;
			await new Promise((resolve) => setTimeout(resolve, 30));
			expect(events).toHaveLength(countAfterStop);
		} finally {
			await ctx.app.close();
		}
	});

	it("stays unready when a start hook fails", async () => {
		const extensionCatalog = await buildExtensionCatalogFromModules([
			{
				manifest: { id: "failed-start", version: "1.0.0" },
				setupServer(api) {
					api.onStart(() => {
						throw new Error("start rejected");
					});
				},
			},
		]);
		const ctx = await createLocalApp({ extensionCatalog });
		try {
			await expect(ctx.startBackgroundServices()).rejects.toThrow("start rejected");
			expect(ctx.isReady()).toBe(false);
			expect((await ctx.app.inject({ url: "/api/ready" })).statusCode).toBe(503);
		} finally {
			await ctx.app.close();
		}
	});
});
