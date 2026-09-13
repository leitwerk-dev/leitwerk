import {
	CONTINUE_PROMPT_METADATA_KEY,
	inferTerminalRecordingFailedTurnRecoveryContext,
	normalizeContinuePrompt,
	readFailedTurnRecoveryContext,
} from "@leitwerk-dev/domain";
import { isTurnAvailableForProcessGraph, type ProcessGraphRegistry } from "../../process-graph.js";
import { readCurrentPrimaryPathLeafEntryId } from "../state-json.js";
import {
	buildRecoveryStartWrites,
	type RecoveryStartWritesInput,
} from "./build-recovery-start-writes.js";
import { appendProcessEvent, updateProcessMetadata, type Writes } from "./writes.js";

export interface ContinueFailedTurnWritesInput extends RecoveryStartWritesInput {
	processGraphs: ProcessGraphRegistry;
	continueFromPiEntryId: string;
	prompt?: string | null;
}

export function buildContinueFailedTurnWrites(input: ContinueFailedTurnWritesInput): Writes {
	const { process, failedRun, continueFromPiEntryId } = input;
	if (!isTurnAvailableForProcessGraph(input.processGraphs, process.processId, failedRun.turnId)) {
		throw new Error(
			`Could not derive a continuable selected turn for '${failedRun.turnId}' on process '${process.processId}'`,
		);
	}
	const failedTurnRecovery =
		readFailedTurnRecoveryContext(process.metadata, failedRun.id) ??
		inferTerminalRecordingFailedTurnRecoveryContext(failedRun);
	if (!failedTurnRecovery) {
		throw new Error(`Failed turn '${failedRun.id}' is missing recovery context`);
	}
	const continuePrompt =
		normalizeContinuePrompt(input.prompt) ??
		normalizeContinuePrompt(process.metadata?.[CONTINUE_PROMPT_METADATA_KEY]) ??
		failedTurnRecovery.suggestedContinuePrompt;
	const currentPrimaryPathLeafEntryId = readCurrentPrimaryPathLeafEntryId(process.stateJson);
	const plan = buildRecoveryStartWrites(input, {
		startKind: "continue",
		turnType: "llm",
		continuation: {
			continueFromPiEntryId,
			continuePrompt: continuePrompt ?? "",
			savedPrimaryLeafEntryId: currentPrimaryPathLeafEntryId,
		},
	});
	updateProcessMetadata(plan, process, ["retry"], (metadata) => {
		metadata.continueFromTurnRecordId = failedRun.id;
		metadata.continueFromPiEntryId = continueFromPiEntryId;
		metadata[CONTINUE_PROMPT_METADATA_KEY] = continuePrompt;
		if (
			failedRun.pathType !== "primary" &&
			currentPrimaryPathLeafEntryId &&
			currentPrimaryPathLeafEntryId !== continueFromPiEntryId
		) {
			metadata.continueSavedPrimaryLeafEntryId = currentPrimaryPathLeafEntryId;
		} else {
			delete metadata.continueSavedPrimaryLeafEntryId;
		}
	});

	const message = `Continue scheduled for turn ${failedRun.turnId}`;
	const data = {
		fromTurnId: process.selectedTurnId,
		toTurnId: failedRun.turnId,
		selectedTurnId: failedRun.turnId,
		failedTurnRecord: failedRun.id,
		continueFromTurnRecordId: failedRun.id,
		continueFromPiEntryId,
		continuePrompt,
		attemptNumber: failedRun.attemptNumber,
	};
	appendProcessEvent(plan, process, {
		eventType: "continue_scheduled",
		level: "info",
		message,
		data,
	});

	return plan;
}
