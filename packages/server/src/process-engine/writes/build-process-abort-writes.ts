import type { ProcessInstance, ProcessTurnRecord, TurnStartRecord } from "@leitwerk-dev/domain";
import type { ProcessGraphRegistry } from "../../process-graph.js";
import { buildTurnSelectionWrites } from "./build-turn-selection-writes.js";
import { appendProcessEvent, isWriteBuildFailure, type WriteBuildResult } from "./writes.js";

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

	if (input.currentWorkerStart?.state.kind === "starting") {
		writes.turnStartWrites.push({
			kind: "cas_state",
			id: input.currentWorkerStart.id,
			expectedKind: "starting",
			state: { kind: "superseded", start: input.currentWorkerStart.state.start },
		});
	}
	if (input.activeTurnRecord?.status === "running") {
		writes.turnRecordWrites.push({
			kind: "update",
			id: input.activeTurnRecord.id,
			input: {
				status: "superseded",
				endedAt: input.recordedAt ?? new Date().toISOString(),
			},
		});
	}

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
