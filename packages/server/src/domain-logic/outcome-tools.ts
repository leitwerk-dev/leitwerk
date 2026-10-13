import {
	isUnknownRecord as isJsonObject,
	normalizeStringArray,
	type TurnOutcomePayload,
	trimString,
} from "@leitwerk-dev/domain";
import {
	isAutomaticTurnDefinition,
	isLlmTurnDefinition,
	type OutcomeToolParameterSpec,
	type TurnDefinition,
	validateOutcomeParameters,
} from "@leitwerk-dev/process-sdk";
import { isTurnAvailableForProcessGraph, type ProcessGraphRegistry } from "../process-graph.js";

interface OutcomeToolValidationContract {
	kind: "outcome_tool";
	parameters: Record<string, OutcomeToolParameterSpec>;
}

interface TurnEndResultValidationContract {
	kind: "turn_end_result";
	expectedParams: Record<string, unknown>;
}

type OutcomeValidationContract = OutcomeToolValidationContract | TurnEndResultValidationContract;

export interface OutcomeValidationFailure {
	ok: false;
	code: string;
	message: string;
}

function validationFailure(code: string, message: string): OutcomeValidationFailure {
	return { ok: false, code, message };
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
	if (left === right) {
		return true;
	}
	if (Array.isArray(left) && Array.isArray(right)) {
		if (left.length !== right.length) {
			return false;
		}
		return left.every((entry, index) => jsonValuesEqual(entry, right[index]));
	}
	if (isJsonObject(left) && isJsonObject(right)) {
		const leftKeys = Object.keys(left).sort();
		const rightKeys = Object.keys(right).sort();
		if (leftKeys.length !== rightKeys.length) {
			return false;
		}
		for (let index = 0; index < leftKeys.length; index += 1) {
			if (leftKeys[index] !== rightKeys[index]) {
				return false;
			}
		}
		return leftKeys.every((key) => jsonValuesEqual(left[key], right[key]));
	}
	return false;
}

function resolveOutcomeValidationContract(
	turnDefinition: TurnDefinition | undefined,
	turnId: string,
	outcome: string,
): OutcomeValidationContract | OutcomeValidationFailure {
	if (!turnDefinition) {
		return validationFailure(
			"turn_not_registered",
			`'${turnId}' is not registered in the loaded turn catalog`,
		);
	}
	if (!isLlmTurnDefinition(turnDefinition) && !isAutomaticTurnDefinition(turnDefinition)) {
		return validationFailure(
			"turn_outcome_unsupported",
			`'${turnId}' does not support turn outcomes`,
		);
	}

	const outcomeSpec = turnDefinition.outcomes?.[outcome];
	if (outcomeSpec) {
		return {
			kind: "outcome_tool",
			parameters: outcomeSpec.parameters,
		};
	}

	if (turnDefinition.turnEnd?.outcome === outcome) {
		return {
			kind: "turn_end_result",
			expectedParams: turnDefinition.turnEnd.params ?? {},
		};
	}

	return validationFailure(
		"outcome_not_registered",
		`'${outcome}' is not registered for turn '${turnId}'`,
	);
}

export function isTurnAvailableForSelectedTurn(
	selectedTurnId: string | null | undefined,
	turnId: string,
): boolean {
	return selectedTurnId === turnId;
}

export function checkTurnOutcomeAvailability(
	registry: ProcessGraphRegistry,
	turnDefinition: TurnDefinition | undefined,
	turnId: string,
	outcome: string,
	processId: string,
	selectedTurnId: string | null | undefined,
): OutcomeValidationFailure | null {
	if (!isTurnAvailableForProcessGraph(registry, processId, turnId)) {
		return validationFailure(
			"turn_not_in_definition",
			`'${turnId}' is not available for process '${processId}'`,
		);
	}

	if (!isTurnAvailableForSelectedTurn(selectedTurnId, turnId)) {
		return validationFailure(
			"turn_unavailable_for_selected_turn",
			`'${turnId}' is not the currently selected turn`,
		);
	}

	const contract = resolveOutcomeValidationContract(turnDefinition, turnId, outcome);
	return "ok" in contract ? contract : null;
}

export function validateChangedProjects(
	changedProjects: unknown,
	knownProjectKeys: ReadonlySet<string> | undefined,
): OutcomeValidationFailure | null {
	if (!Array.isArray(changedProjects) || !knownProjectKeys) return null;
	const normalized = normalizeStringArray(changedProjects);
	const unknown = normalized.filter((key: string) => !knownProjectKeys.has(key));
	if (unknown.length > 0) {
		return validationFailure(
			"unknown_changed_projects",
			`changedProjects contains entries not in the process: ${unknown.join(", ")}`,
		);
	}
	return null;
}

function validateTurnEndResultParams(
	turnId: string,
	outcome: string,
	params: Record<string, unknown>,
	expectedParams: Record<string, unknown>,
): OutcomeValidationFailure | null {
	if (jsonValuesEqual(params, expectedParams)) {
		return null;
	}
	return validationFailure(
		"invalid_turn_end_params",
		`${turnId}.${outcome} payload does not match the declared turnEnd params`,
	);
}

function validateDeclaredOutcomeParameters(
	turnId: string,
	outcome: string,
	params: Record<string, unknown>,
	parameterSpecs: Record<string, OutcomeToolParameterSpec>,
	knownProjectKeys?: ReadonlySet<string>,
): OutcomeValidationFailure | null {
	const [issue] = validateOutcomeParameters(parameterSpecs, params);
	if (issue) return validationFailure(issue.code, `${turnId}.${outcome}: ${issue.message}`);
	const projectError = validateChangedProjects(params.changedProjects, knownProjectKeys);
	if (projectError) {
		return projectError;
	}

	return null;
}

export function validateTurnOutcome(
	payload: TurnOutcomePayload,
	turnDefinition: TurnDefinition | undefined,
	knownProjectKeys?: ReadonlySet<string>,
): OutcomeValidationFailure | null {
	const instanceId = trimString(payload.instanceId);
	if (!instanceId) {
		return validationFailure("missing_instance_id", "instanceId is required");
	}

	const turnRecordId = trimString(payload.turnRecordId);
	if (!turnRecordId) {
		return validationFailure("missing_turn_record_id", "turnRecordId is required");
	}

	const turnId = trimString(payload.turnId);
	if (!turnId) {
		return validationFailure("missing_turn_id", "turnId is required");
	}

	const outcome = trimString(payload.outcome);
	if (!outcome) {
		return validationFailure("missing_outcome", "outcome is required");
	}

	const params = payload.params ?? {};
	if (!isJsonObject(params)) {
		return validationFailure("invalid_params", "params must be an object");
	}

	const contract = resolveOutcomeValidationContract(turnDefinition, turnId, outcome);
	if ("ok" in contract) return contract;

	return contract.kind === "turn_end_result"
		? validateTurnEndResultParams(turnId, outcome, params, contract.expectedParams)
		: validateDeclaredOutcomeParameters(
				turnId,
				outcome,
				params,
				contract.parameters,
				knownProjectKeys,
			);
}
