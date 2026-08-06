import type { Actor } from "@leitwerk-dev/domain";
import type { ProcessVolume } from "@leitwerk-dev/worker-runners";
import type { RepositoryBundle } from "./db/repositories.js";
import type { EngineFailure, ProcessEngine } from "./process-engine/types.js";
import type { ProcessOperationCoordinator } from "./process-operation-coordinator.js";
import type { ProcessSessionSnapshotStore } from "./process-session-store.js";
import type { ResultImageStore } from "./result-image-store.js";
import type { WorkerSupervisor } from "./supervisor/worker-supervisor.js";
import type { Broadcaster } from "./ws/broadcast.js";

export type ProcessDeletionResult =
	| { ok: true }
	| { ok: false; kind: "not_found" }
	| { ok: false; kind: "abort_failed"; failure: EngineFailure<void> }
	| { ok: false; kind: "cleanup_failed"; message: string };

export interface ProcessDeletionService {
	deleteProcess(instanceId: string, actor: Actor): Promise<ProcessDeletionResult>;
}

interface ProcessDeletionDeps extends Pick<RepositoryBundle, "processes"> {
	processEngine: ProcessEngine;
	processOperations: ProcessOperationCoordinator;
	supervisor: WorkerSupervisor;
	volume?: ProcessVolume;
	sessionSnapshots: ProcessSessionSnapshotStore;
	resultImages: ResultImageStore;
	broadcaster: Broadcaster;
	logger?: { error(details: unknown, message: string): void };
}

const TERMINAL_STATUSES = new Set(["completed", "aborted"]);
const CLEANUP_FAILURE_MESSAGE = "The process could not be deleted; retry deletion";

/** Coordinates destructive deletion with the same per-process lifecycle lock as engine writes. */
export function createProcessDeletionService(deps: ProcessDeletionDeps): ProcessDeletionService {
	return {
		async deleteProcess(instanceId, actor) {
			const initial = deps.processes.getById(instanceId);
			if (!initial) return { ok: false, kind: "not_found" };

			if (!TERMINAL_STATUSES.has(initial.lifecycleStatus)) {
				const aborted = await deps.processEngine.abortProcess(instanceId, { actor });
				if (!aborted.ok) return { ok: false, kind: "abort_failed", failure: aborted };
			}

			try {
				await deps.supervisor.stopWorker(instanceId, "process_deleted");
				return await deps.processOperations.runExclusive(instanceId, async () => {
					const process = deps.processes.getById(instanceId);
					if (!process) return { ok: false, kind: "not_found" };
					if (!TERMINAL_STATUSES.has(process.lifecycleStatus)) {
						return { ok: false, kind: "cleanup_failed", message: CLEANUP_FAILURE_MESSAGE };
					}

					await Promise.all([
						deps.volume?.deleteProcessResources(instanceId),
						deps.sessionSnapshots.deleteSnapshot(instanceId),
						deps.resultImages.deleteProcess(instanceId),
					]);
					if (!deps.processes.delete(instanceId)) return { ok: false, kind: "not_found" };

					try {
						deps.broadcaster.sendDurable("process.deleted", { instanceId }, instanceId);
					} catch (error) {
						// Durable deletion already committed, so broadcast failure cannot make it retryable.
						deps.logger?.error({ error, instanceId }, "process deletion broadcast failed");
					}
					return { ok: true };
				});
			} catch (error) {
				deps.logger?.error({ error, instanceId }, "process deletion cleanup failed");
				return { ok: false, kind: "cleanup_failed", message: CLEANUP_FAILURE_MESSAGE };
			}
		},
	};
}
