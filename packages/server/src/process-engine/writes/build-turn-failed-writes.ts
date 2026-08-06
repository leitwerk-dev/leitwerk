import type { ProcessInstance, ProcessTurnRecord, TurnFailedPayload } from "@leitwerk-dev/domain";
import { buildFailedTurnRecoveryMetadata } from "@leitwerk-dev/domain";
import {
	appendProcessEvent,
	applyProcessPatchField,
	createWrites,
	updateProcessMetadata,
	type Writes,
} from "./writes.js";

export interface TurnFailedWritesInput {
	process: ProcessInstance;
	payload: TurnFailedPayload;
	existingTurnRecord: ProcessTurnRecord;
	endedAt?: string;
}

export function buildTurnFailedWrites(input: TurnFailedWritesInput): Writes {
	const { process, payload, existingTurnRecord } = input;
	const endedAt = input.endedAt ?? new Date().toISOString();
	const plan = createWrites();

	const modelProfileId =
		existingTurnRecord.modelProfileId ?? process.selectedTurnModelProfileId ?? null;
	const resultPiEntryId =
		payload.failureCode === "branch_drift" ? null : (payload.resultPiEntryId ?? null);
	const failedTurnFields = {
		turnType: payload.turnType,
		status: "failed" as const,
		resultPiEntryId,
		...(modelProfileId !== null ? { modelProfileId } : {}),
		errorSummary: payload.errorSummary,
		...(payload.errorClass !== undefined ? { errorClass: payload.errorClass } : {}),
		endedAt,
	};
	plan.turnRecordWrites.push({
		kind: "update",
		id: payload.turnRecordId,
		input: failedTurnFields,
	});

	applyProcessPatchField(plan, process, "selectedTurnId", payload.turnId);
	// The accepted worker-start anchor remains current while its linked record fails.
	applyProcessPatchField(plan, process, "lifecycleStatus", "error");
	updateProcessMetadata(plan, process, ["retry", "continuation"], (metadata) => {
		const failedTurnRecovery =
			payload.turnType === "llm" && payload.failureCode !== "branch_drift"
				? (payload.recoveryContext ?? null)
				: null;
		if (failedTurnRecovery) {
			Object.assign(
				metadata,
				buildFailedTurnRecoveryMetadata(payload.turnRecordId, failedTurnRecovery),
			);
		}
	});

	const message = `Turn failed: ${payload.turnId}`;
	const data = {
		turnRecordId: payload.turnRecordId,
		turnId: payload.turnId,
		turnType: payload.turnType,
		errorSummary: payload.errorSummary,
		errorClass: payload.errorClass,
		...(payload.failureCode ? { failureCode: payload.failureCode } : {}),
		...(payload.failureDetails ? { failureDetails: payload.failureDetails } : {}),
	};
	appendProcessEvent(plan, process, {
		eventType: "turn_failed",
		level: "warn",
		message,
		data,
	});

	return plan;
}
