import type { ProcessDetailData } from "./api.js";

function merge<T>(older: readonly T[], current: readonly T[], key: (item: T) => string): T[] {
	return [...new Map([...older, ...current].map((item) => [key(item), item])).values()];
}

/** Add older evidence without replacing live process state or newer versions of records. */
export function mergeProcessHistory(
	current: ProcessDetailData,
	older: ProcessDetailData,
): ProcessDetailData {
	const byId = <T extends { id: string }>(a: readonly T[], b: readonly T[]) =>
		merge(a, b, (item) => item.id);
	return {
		...current,
		timeline: {
			...current.timeline,
			history: older.timeline.history,
			// Only the current snapshot owns live rows, including temporary current: IDs.
			turns: byId(
				older.timeline.turns.filter((turn) => turn.status !== "in_progress"),
				current.timeline.turns,
			).sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id)),
			inputs: byId(older.timeline.inputs, current.timeline.inputs),
			tracePreviewsByTurnRecordId: {
				...older.timeline.tracePreviewsByTurnRecordId,
				...current.timeline.tracePreviewsByTurnRecordId,
			},
		},
		leafOutcomeSnapshots: byId(older.leafOutcomeSnapshots, current.leafOutcomeSnapshots),
		questionRequests: byId(older.questionRequests, current.questionRequests),
		toolApprovalRequests: byId(older.toolApprovalRequests, current.toolApprovalRequests),
		instanceTree: {
			...current.instanceTree,
			nodes: byId(older.instanceTree.nodes, current.instanceTree.nodes),
			edges: byId(older.instanceTree.edges, current.instanceTree.edges),
		},
		startup: {
			...current.startup,
			attempts: merge(
				older.startup.attempts,
				current.startup.attempts,
				(item) => item.startRecordId,
			),
			workerStarts: merge(
				older.startup.workerStarts ?? [],
				current.startup.workerStarts ?? [],
				(item) => item.workerLeaseId,
			),
		},
	};
}
