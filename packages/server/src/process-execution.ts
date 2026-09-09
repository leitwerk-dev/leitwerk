import type { ProcessInstance, TurnStartRecord } from "@leitwerk-dev/domain";

export function resolveCurrentExecutionTurnRecordId(
	process: Pick<ProcessInstance, "currentExecution"> | null | undefined,
	turnStarts: { getById(id: string): TurnStartRecord | null },
): string | null {
	if (process?.currentExecution?.kind !== "worker_start") return null;
	const start = turnStarts.getById(process.currentExecution.id);
	return start?.state.kind === "accepted" ? start.state.turnRecordId : null;
}
