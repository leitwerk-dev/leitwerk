export type WorkerSnapshotPoint =
	| "after_worker_ready"
	| "before_turn_outcome"
	| "before_turn_failed"
	| "before_cleanup_completed"
	| "before_worker_failed";

export type WorkerSnapshotPolicy =
	| { upload: false }
	| { upload: true; required: boolean; turnCorrelated: boolean };

/** Pure snapshot requiredness and correlation policy. */
export function resolveWorkerSnapshotPolicy(
	point: WorkerSnapshotPoint,
	sessionKind: "llm" | "automatic",
	piAvailable: boolean,
): WorkerSnapshotPolicy {
	if (sessionKind === "automatic") return { upload: false };
	if (point === "before_cleanup_completed" && !piAvailable) return { upload: false };
	if (point === "after_worker_ready" || point === "before_worker_failed") {
		return { upload: true, required: false, turnCorrelated: false };
	}
	return {
		upload: true,
		required: true,
		turnCorrelated: point !== "before_cleanup_completed",
	};
}
