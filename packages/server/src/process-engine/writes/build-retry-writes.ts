import { getProcessTurnGraph, type ProcessGraphRegistry } from "../../process-graph.js";
import {
	buildRecoveryStartWrites,
	type RecoveryStartWritesInput,
} from "./build-recovery-start-writes.js";
import { appendProcessEvent, updateProcessMetadata, type Writes } from "./writes.js";

/** @internal */
export interface RetryWritesInput extends RecoveryStartWritesInput {
	/** @internal */
	processGraphs: ProcessGraphRegistry;
}

/** @internal */
export function buildRetryWrites(input: RetryWritesInput): Writes {
	const { process, failedRun } = input;
	const retryTurn = getProcessTurnGraph(input.processGraphs, process.processId, failedRun.turnId);
	if (!retryTurn) {
		throw new Error(
			`Could not derive a retryable selected turn for '${failedRun.turnId}' on process '${process.processId}'`,
		);
	}
	if (retryTurn.turnType !== "llm" && retryTurn.turnType !== "automatic") {
		throw new Error(
			`Worker retry cannot target '${retryTurn.turnType}' turn '${failedRun.turnId}'`,
		);
	}
	const plan = buildRecoveryStartWrites(input, {
		startKind: "retry",
		turnType: retryTurn.turnType,
		continuation: null,
	});
	updateProcessMetadata(plan, process, ["retry", "continuation"], (metadata) => {
		if (failedRun.forkPiEntryId) {
			metadata.retryForkPiEntryId = failedRun.forkPiEntryId;
			metadata.retryFromTurnRecordId = failedRun.id;
		}
	});

	const message = `Retry scheduled for turn ${failedRun.turnId}`;
	const data = {
		fromTurnId: process.selectedTurnId,
		toTurnId: failedRun.turnId,
		selectedTurnId: failedRun.turnId,
		failedTurnRecord: failedRun.id,
		retryForkPiEntryId: failedRun.forkPiEntryId ?? null,
		attemptNumber: failedRun.attemptNumber,
	};
	appendProcessEvent(plan, process, {
		eventType: "retry_scheduled",
		level: "info",
		message,
		data,
	});

	return plan;
}
