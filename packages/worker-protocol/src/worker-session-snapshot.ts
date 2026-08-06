export const WORKER_SESSION_SNAPSHOT_CONTENT_TYPE = "application/x-ndjson";
export const WORKER_SESSION_SNAPSHOT_WORKER_ID_HEADER = "x-leitwerk-worker-id";
export const WORKER_SESSION_SNAPSHOT_REASON_HEADER = "x-leitwerk-session-snapshot-reason";
export const WORKER_SESSION_SNAPSHOT_TURN_RECORD_ID_HEADER = "x-leitwerk-turn-record-id";
export function buildWorkerSessionSnapshotPath(instanceId: string): string {
	return `/internal/workers/${encodeURIComponent(instanceId)}/session-snapshot`;
}
