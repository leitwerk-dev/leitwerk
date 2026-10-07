import type { ProcessInstance } from "@leitwerk-dev/domain";

/** @internal */
export interface ProcessEventRepoLike {
	/** @internal */
	create(input: {
		/** @internal */
		instanceId: string;
		/** @internal */
		eventType: string;
		/** @internal */
		data?: Record<string, unknown>;
	}): unknown;
	/** @internal */
	listByInstance(
		instanceId: string,
		limit?: number,
	): Array<{
		/** @internal */
		eventType: string;
	}>;
}

/** @internal */
export interface WorkerSupervisorLike {
	/** @internal */
	spawnWorker(instanceId: string): Promise<unknown>;
	/** @internal */
	getWorker(instanceId: string): unknown | undefined;
}

/**
 * Check whether a process already has an event of the given type.
 */
/** @internal */
export function hasProcessEvent(
	events: ProcessEventRepoLike,
	instanceId: string,
	eventType: string,
): boolean {
	return events.listByInstance(instanceId, 200).some((event) => event.eventType === eventType);
}

/** @internal */
export function processNeedsWorker(
	process: Pick<ProcessInstance, "selectedTurnId" | "lifecycleStatus">,
): boolean {
	return process.selectedTurnId !== null && process.lifecycleStatus === "active";
}

/**
 * Spawn a worker for a process whose selected turn is runnable but currently has
 * no running worker. No-ops when the process is not worker-runnable or already
 * has a worker.
 */
/** @internal */
export async function ensureWorkerForActiveAgent(
	deps: {
		/** @internal */
		events: ProcessEventRepoLike;
		/** @internal */
		supervisor: WorkerSupervisorLike;
	},
	process: ProcessInstance,
): Promise<void> {
	if (!processNeedsWorker(process) || deps.supervisor.getWorker(process.id)) {
		return;
	}
	try {
		await deps.supervisor.spawnWorker(process.id);
	} catch (error) {
		deps.events.create({
			instanceId: process.id,
			eventType: "worker_spawn_failed",
			data: {
				reason: error instanceof Error ? error.message : "Failed to spawn worker",
			},
		});
		throw error;
	}
}
