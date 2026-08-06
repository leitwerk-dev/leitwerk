import type { WorkerState } from "@leitwerk-dev/domain";

export type WorkerLeaseObservation =
	| "spawn_requested"
	| "handshake_received"
	| "bootstrap_completed"
	| "busy_reported"
	| "idle_reported"
	| "stop_requested"
	| "failure_reported"
	| "cleanup_completed"
	| "process_exited"
	| "reclaimed";

export interface WorkerLeaseTransitionRule {
	from: WorkerState;
	to: WorkerState;
	observation: WorkerLeaseObservation;
}

const WORKER_LEASE_TRANSITIONS: ReadonlyArray<WorkerLeaseTransitionRule> = [
	{ from: "absent", to: "spawning", observation: "spawn_requested" },

	{ from: "spawning", to: "bootstrapping", observation: "handshake_received" },

	{ from: "bootstrapping", to: "idle", observation: "bootstrap_completed" },

	{ from: "idle", to: "busy", observation: "busy_reported" },
	{ from: "busy", to: "idle", observation: "idle_reported" },

	{ from: "spawning", to: "draining", observation: "stop_requested" },
	{ from: "bootstrapping", to: "draining", observation: "stop_requested" },
	{ from: "idle", to: "draining", observation: "stop_requested" },
	{ from: "busy", to: "draining", observation: "stop_requested" },

	{ from: "spawning", to: "failed", observation: "failure_reported" },
	{ from: "bootstrapping", to: "failed", observation: "failure_reported" },
	{ from: "idle", to: "failed", observation: "failure_reported" },
	{ from: "busy", to: "failed", observation: "failure_reported" },
	{ from: "draining", to: "failed", observation: "failure_reported" },

	{ from: "draining", to: "cleanup", observation: "cleanup_completed" },
	{ from: "failed", to: "cleanup", observation: "cleanup_completed" },

	{ from: "spawning", to: "exited", observation: "process_exited" },
	{ from: "bootstrapping", to: "exited", observation: "process_exited" },
	{ from: "idle", to: "exited", observation: "process_exited" },
	{ from: "busy", to: "exited", observation: "process_exited" },
	{ from: "draining", to: "exited", observation: "process_exited" },
	{ from: "failed", to: "exited", observation: "process_exited" },
	{ from: "cleanup", to: "exited", observation: "process_exited" },

	{ from: "exited", to: "absent", observation: "reclaimed" },
];

const WORKER_LEASE_NOOPS: Readonly<Record<WorkerLeaseObservation, ReadonlySet<WorkerState>>> = {
	spawn_requested: new Set(),
	handshake_received: new Set([
		"bootstrapping",
		"idle",
		"busy",
		"draining",
		"failed",
		"cleanup",
		"exited",
	]),
	bootstrap_completed: new Set(["idle", "busy", "draining", "failed", "cleanup", "exited"]),
	busy_reported: new Set(["busy", "draining", "failed", "cleanup", "exited"]),
	idle_reported: new Set(["idle", "draining", "failed", "cleanup", "exited"]),
	stop_requested: new Set(["absent", "draining", "failed", "cleanup", "exited"]),
	failure_reported: new Set(["failed", "cleanup", "exited"]),
	cleanup_completed: new Set(["cleanup", "exited"]),
	process_exited: new Set(["absent", "exited"]),
	reclaimed: new Set(["absent"]),
};

export interface AppliedWorkerLeaseObservationResult {
	kind: "applied";
	from: WorkerState;
	to: WorkerState;
	observation: WorkerLeaseObservation;
}

export interface NoopWorkerLeaseObservationResult {
	kind: "noop";
	from: WorkerState;
	to: WorkerState;
	observation: WorkerLeaseObservation;
	reason: string;
}

export interface InvalidWorkerLeaseObservationResult {
	kind: "invalid";
	from: WorkerState;
	observation: WorkerLeaseObservation;
	message: string;
}

export type WorkerLeaseObservationResult =
	| AppliedWorkerLeaseObservationResult
	| NoopWorkerLeaseObservationResult
	| InvalidWorkerLeaseObservationResult;

export function normalizeWorkerLeaseState(state: WorkerState | null | undefined): WorkerState {
	return state ?? "absent";
}

export function transitionWorkerLeaseState(
	currentState: WorkerState | null | undefined,
	observation: WorkerLeaseObservation,
): WorkerLeaseObservationResult {
	const normalizedState = normalizeWorkerLeaseState(currentState);
	const appliedRule = WORKER_LEASE_TRANSITIONS.find(
		(rule) => rule.from === normalizedState && rule.observation === observation,
	);
	if (appliedRule) {
		return {
			kind: "applied",
			from: appliedRule.from,
			to: appliedRule.to,
			observation,
		};
	}

	if (WORKER_LEASE_NOOPS[observation]?.has(normalizedState)) {
		return {
			kind: "noop",
			from: normalizedState,
			to: normalizedState,
			observation,
			reason: `Observation '${observation}' is already satisfied from worker lease state '${normalizedState}'`,
		};
	}

	return {
		kind: "invalid",
		from: normalizedState,
		observation,
		message: `No worker lease transition from '${normalizedState}' with observation '${observation}'`,
	};
}
