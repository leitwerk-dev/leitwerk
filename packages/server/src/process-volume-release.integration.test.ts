import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import { createTestAppContext } from "@leitwerk-dev/test-support/integration";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { getDefaultConfig } from "./config/index.js";
import { fakeWorkerRunnerRuntime } from "./test-helpers/worker-runner-runtime.js";

async function fixture(reclaimOnClose = true) {
	const config = getDefaultConfig();
	config.storage.sqlite_path = ":memory:";
	config.server.host = "127.0.0.1";
	config.server.port = 0;
	config.workers.runner = "kubernetes";
	if (!config.kubernetes) throw new Error("fixture requires Kubernetes config");
	config.kubernetes.process_volume.reclaim_on_close = reclaimOnClose;
	const runtime = fakeWorkerRunnerRuntime();
	const ctx = await createTestAppContext({
		logger: false,
		config,
		extensionCatalog: buildExtensionCatalogFromModules([]),
		workerRunnerRuntime: runtime,
	});
	onTestFinished(() => ctx.close());
	const volume = runtime.volume;
	if (!volume) throw new Error("fixture requires process storage");
	return { ctx, runtime, volume };
}

describe("terminal process PVC release", () => {
	it("keeps existing retention behavior unless terminal reclamation is enabled", async () => {
		const { ctx, volume } = await fixture(false);
		const process = ctx.deps.processes.create({ processId: "test", lifecycleStatus: "active" });
		expect(await ctx.deps.processEngine.abortProcess(process.id)).toMatchObject({ ok: true });
		expect(volume.release).not.toHaveBeenCalled();
	});

	it("releases an aborted process before the abort operation returns, without waiting for a sweep", async () => {
		const { ctx, runtime } = await fixture();
		const process = ctx.deps.processes.create({ processId: "test", lifecycleStatus: "active" });
		expect(await ctx.deps.processEngine.abortProcess(process.id)).toMatchObject({ ok: true });
		expect(runtime.volume?.release).toHaveBeenCalledWith(process.id, {
			reclaimBackingStorage: { lifecycleStatus: "aborted", closedAt: expect.any(String) },
		});
		expect(runtime.volume?.deleteProcessResources).not.toHaveBeenCalled();
	});

	it("releases newly completed PVCs but keeps error and waiting workspaces", async () => {
		const { ctx, volume } = await fixture();
		for (const lifecycleStatus of ["completed", "error", "waiting"] as const) {
			const process = ctx.deps.processes.create({ processId: "test", lifecycleStatus });
			ctx.deps.processes.update(process.id, { closedAt: new Date().toISOString() });
			expect(await ctx.deps.processEngine.updateSemanticEntryRefs(process.id, {})).toMatchObject({
				ok: true,
			});
			if (lifecycleStatus === "completed") {
				expect(volume.release).toHaveBeenCalledWith(process.id, {
					reclaimBackingStorage: { lifecycleStatus: "completed", closedAt: expect.any(String) },
				});
			} else {
				expect(vi.mocked(volume.release).mock.calls.map((call) => call[0])).not.toContain(
					process.id,
				);
			}
		}
	});

	it("does not undo a durable abort when release fails and retries without a permanent process-id cache", async () => {
		const { ctx, volume } = await fixture();
		const release = vi.mocked(volume.release);
		release.mockRejectedValueOnce(new Error("PVC still referenced"));
		const process = ctx.deps.processes.create({ processId: "test", lifecycleStatus: "active" });
		expect(await ctx.deps.processEngine.abortProcess(process.id)).toMatchObject({ ok: true });
		expect(ctx.deps.processes.getById(process.id)?.lifecycleStatus).toBe("aborted");
		expect(await ctx.deps.processEngine.updateSemanticEntryRefs(process.id, {})).toMatchObject({
			ok: true,
		});
		expect(release).toHaveBeenCalledTimes(2);
	});
});
