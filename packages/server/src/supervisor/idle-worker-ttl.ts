import {
	isWorkerOwnedTurnType,
	type ProcessInput,
	type ProcessInstance,
	type ProcessTurnType,
	type WorkerLease,
} from "@leitwerk-dev/domain";

export type IdleWorkerStopDecision = { shouldStop: true } | { shouldStop: false; reason: string };

export function decideIdleWorkerStop(input: {
	idleTtlMs: number;
	hasWorkerHandle: boolean;
	lease: Pick<WorkerLease, "workerId" | "state"> | null | undefined;
	workerId: string;
	process: Pick<ProcessInstance, "selectedTurnId" | "lifecycleStatus"> | null | undefined;
	selectedTurn: { turnType: ProcessTurnType } | null | undefined;
	unconsumedInputs: readonly Pick<ProcessInput, "consumedAt">[];
}): IdleWorkerStopDecision {
	if (input.idleTtlMs <= 0) {
		return { shouldStop: false, reason: "disabled" };
	}
	if (!input.hasWorkerHandle) {
		return { shouldStop: false, reason: "worker_not_running" };
	}
	if (!input.lease || input.lease.workerId !== input.workerId || input.lease.state !== "idle") {
		return { shouldStop: false, reason: "lease_not_idle" };
	}
	if (!input.process) {
		return { shouldStop: false, reason: "process_missing" };
	}
	if (input.unconsumedInputs.some((entry) => entry.consumedAt === null)) {
		return { shouldStop: false, reason: "unconsumed_inputs" };
	}
	if (
		input.process.lifecycleStatus === "active" &&
		input.process.selectedTurnId !== null &&
		input.selectedTurn &&
		isWorkerOwnedTurnType(input.selectedTurn.turnType)
	) {
		return { shouldStop: false, reason: "selected_turn_requires_worker" };
	}
	return { shouldStop: true };
}
