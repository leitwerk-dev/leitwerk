/** @internal */
export const WORKER_SESSION_SNAPSHOT_CONTENT_TYPE = "application/x-ndjson";
/** @internal */
export const WORKER_SESSION_SNAPSHOT_WORKER_ID_HEADER = "x-leitwerk-worker-id";
/** @internal */
export const WORKER_SESSION_SNAPSHOT_REASON_HEADER = "x-leitwerk-session-snapshot-reason";
/** @internal */
export const WORKER_SESSION_SNAPSHOT_TURN_RECORD_ID_HEADER = "x-leitwerk-turn-record-id";
/** @internal */
export function buildWorkerSessionSnapshotPath(instanceId: string): string {
	return `/internal/workers/${encodeURIComponent(instanceId)}/session-snapshot`;
}
