import type { ProcessInstance, TurnFailedPayload, TurnOutcomePayload } from "@leitwerk-dev/domain";

export interface TurnRecordValidationFailure {
	ok: false;
	code: string;
	message: string;
}

function validationFailure(code: string, message: string): TurnRecordValidationFailure {
	return { ok: false, code, message };
}

function staleTurnRecordResult(message: string): TurnRecordValidationFailure {
	return validationFailure("stale_turn_record", message);
}

export function validateTurnOutcomeCorrelation(
	process: ProcessInstance,
	payload: TurnOutcomePayload,
	expectedTurnRecordId: string | null = process.currentExecution?.kind === "server_turn"
		? process.currentExecution.id
		: null,
): TurnRecordValidationFailure | null {
	if (typeof payload.turnRecordId !== "string" || payload.turnRecordId.trim() === "") {
		return validationFailure(
			"missing_turn_record_id",
			"turnRecordId is required for turn outcomes",
		);
	}
	if (expectedTurnRecordId !== payload.turnRecordId) {
		return staleTurnRecordResult(
			`Ignoring turn outcome for stale turnRecordId '${payload.turnRecordId}'`,
		);
	}
	return null;
}

export function validateTurnFailedCorrelation(
	process: ProcessInstance,
	payload: TurnFailedPayload,
	expectedTurnRecordId: string | null = process.currentExecution?.kind === "server_turn"
		? process.currentExecution.id
		: null,
): TurnRecordValidationFailure | null {
	if (expectedTurnRecordId !== payload.turnRecordId) {
		return staleTurnRecordResult(
			`Ignoring turn failure for stale turnRecordId '${payload.turnRecordId}'`,
		);
	}
	return null;
}
