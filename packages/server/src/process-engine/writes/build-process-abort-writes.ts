import type { ProcessInstance, ProcessTurnRecord, TurnStartRecord } from "@leitwerk-dev/domain";
import type { ProcessGraphRegistry } from "../../process-graph.js";
import { buildTurnSelectionWrites } from "./build-turn-selection-writes.js";
import {
	appendProcessEvent,
	isWriteBuildFailure,
	type WriteBuildResult,
	type Writes,
} from "./writes.js";

/** Fence accepted and pending execution without choosing the next business position. @internal */
export function supersedeExecution(
	writes: Writes,
	record: ProcessTurnRecord | null,
	start?: TurnStartRecord | null,
	recordedAt?: string,
): void {
	writes.mappedRunWrites.push({ kind: "abort_active" });
	if (start?.state.kind === "starting")
		writes.turnStartWrites.push({
			kind: "cas_state",
			id: start.id,
			expectedKind: "starting",
			state: { kind: "superseded", start: start.state.start },
		});
	if (record?.status === "running")
		writes.turnRecordWrites.push({
			kind: "update",
			id: record.id,
			input: { status: "superseded", endedAt: recordedAt ?? new Date().toISOString() },
		});
}

export function buildAbortProcessWrites(input: {
	processGraphs: ProcessGraphRegistry;
	process: ProcessInstance;
	activeTurnRecord: ProcessTurnRecord | null;
	currentWorkerStart?: TurnStartRecord | null;
	recordedAt?: string;
}): WriteBuildResult {
	const writes = buildTurnSelectionWrites(input.processGraphs, input.process, {
		fromTurnId: input.process.selectedTurnId,
		toTurnId: null,
		trigger: "abort",
		lifecycleStatus: "aborted",
	});
	if (isWriteBuildFailure(writes)) {
		return writes;
	}

	supersedeExecution(writes, input.activeTurnRecord, input.currentWorkerStart, input.recordedAt);

	// Without a selected turn, abort has no turn_selected event to attribute.
	if (input.process.selectedTurnId === null) {
		appendProcessEvent(writes, input.process, {
			eventType: "process_aborted",
			level: "info",
			message: "Process aborted",
			data: {
				fromTurnId: input.process.selectedTurnId,
				toTurnId: null,
				fromLifecycleStatus: input.process.lifecycleStatus,
				toLifecycleStatus: "aborted",
				trigger: "abort",
			},
		});
	}
	return writes;
}
