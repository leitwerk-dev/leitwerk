import type { ProcessInstance, ProcessTurnRecord, TurnStartRecord } from "@leitwerk-dev/domain";
import {
	CONTINUE_PROMPT_METADATA_KEY,
	normalizeContinuePrompt,
	readFailedTurnRecoveryContext,
} from "@leitwerk-dev/domain";
import { generateId } from "../../db/repo-helpers.js";
import { isTurnAvailableForProcessGraph, type ProcessGraphRegistry } from "../../process-graph.js";
import { readCurrentPrimaryPathLeafEntryId } from "../state-json.js";
import {
	appendProcessEvent,
	applyProcessPatchField,
	createWrites,
	updateProcessMetadata,
	type Writes,
} from "./writes.js";

export interface ContinueFailedTurnWritesInput {
	processGraphs: ProcessGraphRegistry;
	process: ProcessInstance;
	failedRun: ProcessTurnRecord;
	acceptedStart: TurnStartRecord;
	continueFromPiEntryId: string;
	prompt?: string | null;
}

export function buildContinueFailedTurnWrites(input: ContinueFailedTurnWritesInput): Writes {
	const { process, failedRun, continueFromPiEntryId, acceptedStart } = input;
	if (!isTurnAvailableForProcessGraph(input.processGraphs, process.processId, failedRun.turnId)) {
		throw new Error(
			`Could not derive a continuable selected turn for '${failedRun.turnId}' on process '${process.processId}'`,
		);
	}
	const failedTurnRecovery = readFailedTurnRecoveryContext(process.metadata, failedRun.id);
	if (!failedTurnRecovery) {
		throw new Error(`Failed turn '${failedRun.id}' is missing recovery context`);
	}
	const continuePrompt =
		normalizeContinuePrompt(input.prompt) ??
		normalizeContinuePrompt(process.metadata?.[CONTINUE_PROMPT_METADATA_KEY]) ??
		failedTurnRecovery.suggestedContinuePrompt;
	const currentPrimaryPathLeafEntryId = readCurrentPrimaryPathLeafEntryId(process.stateJson);
	const plan = createWrites({ workerIntent: { kind: "restart_worker" } });
	applyProcessPatchField(plan, process, "selectedTurnId", failedRun.turnId);
	applyProcessPatchField(plan, process, "lifecycleStatus", "active");
	if (acceptedStart.state.kind !== "accepted" || acceptedStart.state.start.kind !== "llm")
		throw new Error("Continue requires an accepted LLM start");
	const startId = generateId("tsr");
	plan.turnStartWrites.push({
		kind: "create",
		input: {
			id: startId,
			instanceId: process.id,
			turnId: failedRun.turnId,
			turnType: "llm",
			proposedTurnRecordId: generateId("trn"),
			startKind: "continue",
			recoveryTurnRecordId: failedRun.id,
			continuation: {
				continueFromPiEntryId,
				continuePrompt: continuePrompt ?? "",
				savedPrimaryLeafEntryId: currentPrimaryPathLeafEntryId,
			},
			state: {
				kind: "preparation_failed",
				requestedModelProfileId: failedRun.modelProfileId,
				providerOptions: { ...acceptedStart.state.start.providerOptions },
				code: "model_required",
				safeSummary: "Model selection is pending continue preparation",
				modelSelectionProvenance: failedRun.modelSelectionProvenance ?? {
					kind: "inherited",
					source: "legacy_persisted",
				},
			},
		},
	});
	applyProcessPatchField(plan, process, "currentExecution", { kind: "worker_start", id: startId });
	if (failedRun.modelProfileId !== null) {
		applyProcessPatchField(plan, process, "selectedTurnModelProfileId", failedRun.modelProfileId);
		const provenance = failedRun.modelSelectionProvenance ?? {
			kind: "inherited" as const,
			source: "legacy_persisted" as const,
		};
		applyProcessPatchField(plan, process, "selectedTurnModelKind", provenance.kind);
		applyProcessPatchField(plan, process, "selectedTurnModelSource", provenance.source);
	}
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
