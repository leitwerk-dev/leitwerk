import type { ProcessInstance, ProcessTurnRecord, TurnStartRecord } from "@leitwerk-dev/domain";
import type { ProcessGraphRegistry } from "../../process-graph.js";
import { buildTurnSelectionWrites } from "./build-turn-selection-writes.js";
import {
	applyProcessPatchField,
	createWrites,
	isWriteBuildFailure,
	mergeWrites,
	type WriteBuildResult,
} from "./writes.js";

export function buildAbortProcessWrites(input: {
	processGraphs: ProcessGraphRegistry;
	process: ProcessInstance;
	activeTurnRecord: ProcessTurnRecord | null;
	currentWorkerStart?: TurnStartRecord | null;
	recordedAt?: string;
}): WriteBuildResult {
	const selectionWrites = buildTurnSelectionWrites(input.processGraphs, input.process, {
		fromTurnId: input.process.selectedTurnId,
		toTurnId: null,
		trigger: "abort",
		lifecycleStatus: "aborted",
	});
	if (isWriteBuildFailure(selectionWrites)) {
		return selectionWrites;
	}

	const cleanupWrites = createWrites();
	applyProcessPatchField(cleanupWrites, input.process, "currentExecution", null);
	if (input.currentWorkerStart?.state.kind === "starting") {
		cleanupWrites.turnStartWrites.push({
			kind: "cas_state",
			id: input.currentWorkerStart.id,
			expectedKind: "starting",
			state: { kind: "superseded", start: input.currentWorkerStart.state.start },
		});
	}
	if (input.activeTurnRecord?.status === "running") {
		cleanupWrites.turnRecordWrites.push({
			kind: "update",
			id: input.activeTurnRecord.id,
			input: {
				status: "superseded",
				endedAt: input.recordedAt ?? new Date().toISOString(),
			},
		});
	}

	const writes = mergeWrites(selectionWrites, cleanupWrites);

	// The common abort path clears a selected turn, so `buildTurnSelectionWrites`
	// already emits a `turn_selected` (trigger `abort`) event and broadcast that
	// carries the attribution. Only when no turn selection changes (e.g. aborting
	// a `discovered` process whose selectedTurnId is already null) is there no
	// event to attribute, so we synthesize a dedicated `process_aborted` event.
	const emittedTurnSelected = writes.events.some((event) => event.eventType === "turn_selected");
	if (!emittedTurnSelected) {
		writes.events.push({
			instanceId: input.process.id,
			eventType: "process_aborted",
			data: {
				fromTurnId: input.process.selectedTurnId,
				toTurnId: null,
				fromLifecycleStatus: input.process.lifecycleStatus,
				toLifecycleStatus: "aborted",
				trigger: "abort",
			},
		});
		writes.broadcasts.push({
			type: "process.event",
			payload: {
				eventType: "process_aborted",
				level: "info",
				message: "Process aborted",
			},
			instanceId: input.process.id,
		});
	}
	return writes;
}
