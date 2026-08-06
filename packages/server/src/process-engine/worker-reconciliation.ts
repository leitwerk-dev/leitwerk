import type { ProcessTurnSelectionChange } from "../process-engine/types.js";
import type { ProcessGraphRegistry } from "../process-graph.js";
import type { WorkerSupervisor } from "../supervisor/worker-supervisor.js";
import { selectedTurnRequiresWorker } from "./turn-worker-requirement.js";

export interface WorkerReconciliationResult {
	startedWorker: boolean;
}

export async function reconcileWorkerForProcessTurnSelection(
	supervisor: WorkerSupervisor | undefined,
	instanceId: string,
	processId: string,
	processGraphs: ProcessGraphRegistry | undefined,
	change: ProcessTurnSelectionChange,
): Promise<WorkerReconciliationResult> {
	if (!supervisor) {
		return { startedWorker: false };
	}
	if (
		change.fromTurnId === change.toTurnId &&
		change.fromLifecycleStatus === change.toLifecycleStatus
	) {
		return { startedWorker: false };
	}

	const worker = supervisor.getWorker(instanceId);
	const reason = `turn_changed:${change.toTurnId ?? change.toLifecycleStatus}`;
	const targetNeedsWorker = selectedTurnRequiresWorker(processGraphs, {
		processId,
		selectedTurnId: change.toTurnId,
		lifecycleStatus: change.toLifecycleStatus,
	});
	if (!targetNeedsWorker) {
		if (worker) {
			await supervisor.stopWorker(instanceId, reason);
		}
		return { startedWorker: false };
	}

	if (worker) {
		await supervisor.stopWorker(instanceId, reason);
	}
	await supervisor.spawnWorker(instanceId);
	return { startedWorker: true };
}
