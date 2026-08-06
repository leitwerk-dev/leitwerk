import type { FutureExecutionSummary } from "./api.js";

export function upsertFutureExecutionSummary(
	items: readonly FutureExecutionSummary[],
	item: FutureExecutionSummary,
): FutureExecutionSummary[] {
	const index = items.findIndex((candidate) => candidate.id === item.id);
	if (index < 0) {
		return [item, ...items];
	}
	return items.map((candidate, candidateIndex) => (candidateIndex === index ? item : candidate));
}
