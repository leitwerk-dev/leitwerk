import type { ProcessInstance, ProcessTurnRecord, TurnStartRecord } from "@leitwerk-dev/domain";
import { generateId } from "../../db/repo-helpers.js";
import { getProcessTurnGraph, type ProcessGraphRegistry } from "../../process-graph.js";
import {
	appendProcessEvent,
	applyProcessPatchField,
	createWrites,
	updateProcessMetadata,
	type Writes,
} from "./writes.js";

export interface RetryWritesInput {
	processGraphs: ProcessGraphRegistry;
	process: ProcessInstance;
	failedRun: ProcessTurnRecord;
	acceptedStart: TurnStartRecord;
}

export function buildRetryWrites(input: RetryWritesInput): Writes {
	const { process, failedRun, acceptedStart } = input;
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
	const plan = createWrites({ workerIntent: { kind: "restart_worker" } });
	applyProcessPatchField(plan, process, "selectedTurnId", failedRun.turnId);
	applyProcessPatchField(plan, process, "lifecycleStatus", "active");
	if (acceptedStart.state.kind !== "accepted") throw new Error("Retry requires an accepted start");
	const startId = generateId("tsr");
	plan.turnStartWrites.push({
		kind: "create",
		input: {
			id: startId,
			instanceId: process.id,
			turnId: failedRun.turnId,
			turnType: retryTurn.turnType,
			proposedTurnRecordId: generateId("trn"),
			startKind: "retry",
			recoveryTurnRecordId: failedRun.id,
			continuation: null,
			state:
				retryTurn.turnType === "automatic"
					? { kind: "starting", start: { kind: "automatic" } }
					: {
							kind: "preparation_failed",
							requestedModelProfileId: failedRun.modelProfileId,
							providerOptions:
								acceptedStart.state.start.kind === "llm"
									? { ...acceptedStart.state.start.providerOptions }
									: {},
							code: "model_required",
							safeSummary: "Model selection is pending retry preparation",
							modelSelectionProvenance: failedRun.modelSelectionProvenance ?? {
								kind: "inherited",
								source: "legacy_persisted",
							},
						},
		},
	});
	applyProcessPatchField(plan, process, "currentExecution", {
		kind: "worker_start",
		id: startId,
	});
	if (failedRun.modelProfileId !== null) {
		applyProcessPatchField(plan, process, "selectedTurnModelProfileId", failedRun.modelProfileId);
		const provenance = failedRun.modelSelectionProvenance ?? {
			kind: "inherited" as const,
			source: "legacy_persisted" as const,
		};
		applyProcessPatchField(plan, process, "selectedTurnModelKind", provenance.kind);
		applyProcessPatchField(plan, process, "selectedTurnModelSource", provenance.source);
	}
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
