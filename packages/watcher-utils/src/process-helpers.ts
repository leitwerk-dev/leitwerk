import type { ProcessInstance } from "@leitwerk-dev/domain";

export interface ProcessEventRepoLike {
	create(input: { instanceId: string; eventType: string; data?: Record<string, unknown> }): unknown;
	listByInstance(instanceId: string, limit?: number): Array<{ eventType: string }>;
}

export interface WorkerSupervisorLike {
	spawnWorker(instanceId: string): Promise<unknown>;
	getWorker(instanceId: string): unknown | undefined;
}

/**
 * Check whether a process already has an event of the given type.
 */
export function hasProcessEvent(
	events: ProcessEventRepoLike,
	instanceId: string,
	eventType: string,
): boolean {
	return events.listByInstance(instanceId, 200).some((event) => event.eventType === eventType);
}

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
export async function ensureWorkerForActiveAgent(
	deps: { events: ProcessEventRepoLike; supervisor: WorkerSupervisorLike },
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
