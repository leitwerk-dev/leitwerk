import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Actor } from "@leitwerk-dev/domain";
import type { ProcessVolume } from "@leitwerk-dev/worker-runners";
import { describe, expect, it, vi } from "vitest";
import { createProcessDeletionService } from "./process-deletion-service.js";
import type { ProcessEngine } from "./process-engine/types.js";
import { createProcessOperationCoordinator } from "./process-operation-coordinator.js";
import { createFileBackedProcessSessionSnapshotStore } from "./process-session-store.js";
import { ResultImageStore } from "./result-image-store.js";
import type { WorkerSupervisor } from "./supervisor/worker-supervisor.js";
import { createTestDeps } from "./test-helpers/unit-deps.js";

const ACTOR: Actor = { id: "operator", source: "auth" };

type TestDeps = ReturnType<typeof createTestDeps>;

async function makeService(
	options: {
		processEngine?: (deps: TestDeps) => ProcessEngine;
		stopWorker?: ReturnType<typeof vi.fn>;
		volume?: ProcessVolume;
	} = {},
) {
	const deps = createTestDeps();
	const root = await mkdtemp(path.join(os.tmpdir(), "leitwerk-process-delete-"));
	const snapshots = createFileBackedProcessSessionSnapshotStore(path.join(root, "sessions"));
	const images = new ResultImageStore({ rootDir: path.join(root, "images") });
	const stopWorker = options.stopWorker ?? vi.fn(async () => undefined);
	const service = createProcessDeletionService({
		processes: deps.processes,
		processEngine: options.processEngine?.(deps) ?? ({} as ProcessEngine),
		processOperations: createProcessOperationCoordinator(),
		supervisor: { stopWorker } as unknown as WorkerSupervisor,
		volume: options.volume,
		sessionSnapshots: snapshots,
		resultImages: images,
		broadcaster: deps.broadcaster,
	});
	return { deps, images, service, snapshots, stopWorker };
}

describe("process deletion service", () => {
	it("deletes terminal history and all runner-managed resources before broadcasting", async () => {
		const release = vi.fn(async () => undefined);
		const deleteProcessResources = vi.fn(async () => undefined);
		const fixture = await makeService({
			volume: { ensure: vi.fn(), release, deleteProcessResources },
		});
		const process = fixture.deps.processes.create({
			processId: "test_process",
			lifecycleStatus: "completed",
		});
		fixture.deps.events.create({ instanceId: process.id, eventType: "completed" });
		await fixture.snapshots.writeSnapshot(process.id, "snapshot\n");
		const image = await fixture.images.put({
			instanceId: process.id,
			turnRecordId: "turn_1",
			bytes: Buffer.from("image"),
			mimeType: "image/png",
		});
		const frames: string[] = [];
		fixture.deps.broadcaster.addClient({
			readyState: 1,
			send: (frame) => frames.push(frame),
			on: () => undefined,
		});

		expect(await fixture.service.deleteProcess(process.id, ACTOR)).toEqual({ ok: true });
		expect(fixture.deps.processes.getById(process.id)).toBeNull();
		expect(fixture.deps.events.listByInstance(process.id)).toEqual([]);
		expect(await fixture.snapshots.readRawSnapshot(process.id)).toBeNull();
		expect(await fixture.images.get(process.id, "turn_1", image.imageId)).toBeNull();
		expect(deleteProcessResources).toHaveBeenCalledWith(process.id);
		expect(release).not.toHaveBeenCalled();
		expect(JSON.parse(frames.at(-1) ?? "{}")).toMatchObject({
			type: "process.deleted",
			instanceId: process.id,
			payload: { instanceId: process.id },
		});
	});

	it("aborts active work and stops its worker before deletion", async () => {
		const abortProcess = vi.fn();
		const fixture = await makeService({
			processEngine: (deps) => {
				abortProcess.mockImplementation(async (instanceId: string) => {
					const process = deps.processes.update(instanceId, { lifecycleStatus: "aborted" });
					if (!process) throw new Error("fixture process disappeared");
					return { ok: true as const, process, data: undefined };
				});
				return { abortProcess } as unknown as ProcessEngine;
			},
		});
		const process = fixture.deps.processes.create({
			processId: "test_process",
			lifecycleStatus: "active",
		});

		expect(await fixture.service.deleteProcess(process.id, ACTOR)).toEqual({ ok: true });
		expect(abortProcess).toHaveBeenCalledWith(process.id, { actor: ACTOR });
		expect(fixture.stopWorker).toHaveBeenCalledWith(process.id, "process_deleted");
	});

	it("preserves the durable process when managed cleanup fails", async () => {
		const fixture = await makeService({
			volume: {
				ensure: vi.fn(),
				release: vi.fn(),
				deleteProcessResources: vi.fn(async () => {
					throw new Error("volume unavailable");
				}),
			},
		});
		const process = fixture.deps.processes.create({
			processId: "test_process",
			lifecycleStatus: "aborted",
		});

		await expect(fixture.service.deleteProcess(process.id, ACTOR)).resolves.toMatchObject({
			ok: false,
			kind: "cleanup_failed",
		});
		expect(fixture.deps.processes.getById(process.id)).not.toBeNull();
	});

	it("returns not found without touching cleanup", async () => {
		const fixture = await makeService();

		expect(await fixture.service.deleteProcess("missing", ACTOR)).toEqual({
			ok: false,
			kind: "not_found",
		});
		expect(fixture.stopWorker).not.toHaveBeenCalled();
	});
});
