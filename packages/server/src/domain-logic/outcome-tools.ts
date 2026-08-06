import type { TurnOutcomePayload } from "@leitwerk-dev/domain";
import type { OutcomeToolParameterSpec, TurnDefinition } from "@leitwerk-dev/process-sdk";
import {
	isAutomaticTurnDefinition,
	isLlmTurnDefinition,
	isServerAutomaticTurnDefinition,
} from "@leitwerk-dev/process-sdk";
import * as v from "valibot";
import { isTurnAvailableForProcessGraph, type ProcessGraphRegistry } from "../process-graph.js";
import { normalizeStringArray, trimString } from "./string-normalize.js";

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

function toSnakeCase(value: string): string {
	return value
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/[^a-zA-Z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.toLowerCase();
}

function invalidParameterCode(key: string, spec: OutcomeToolParameterSpec): string {
	return spec.invalidErrorCode ?? `invalid_${toSnakeCase(key)}`;
}

function requiredParameterError(
	turnId: string,
	outcome: string,
	key: string,
	spec: OutcomeToolParameterSpec,
): OutcomeValidationFailure {
	return validationFailure(
		spec.requiredErrorCode ?? `${toSnakeCase(key)}_required`,
		`${turnId}.${outcome} requires a non-empty ${key}`,
	);
}

function minItemsParameterError(
	turnId: string,
	outcome: string,
	key: string,
	spec: OutcomeToolParameterSpec,
): OutcomeValidationFailure {
	return validationFailure(
		spec.minItemsErrorCode ?? spec.requiredErrorCode ?? `${toSnakeCase(key)}_required`,
		`${turnId}.${outcome} requires at least ${spec.minItems ?? 0} item(s) for ${key}`,
	);
}

function invalidParameterError(
	turnId: string,
	outcome: string,
	key: string,
	spec: OutcomeToolParameterSpec,
	expected: string,
): OutcomeValidationFailure {
	return validationFailure(
		invalidParameterCode(key, spec),
		`${turnId}.${outcome} expects ${key} to be ${expected}`,
	);
}

function minimumParameterError(
	turnId: string,
	outcome: string,
	key: string,
	spec: OutcomeToolParameterSpec,
): OutcomeValidationFailure {
	return validationFailure(
		spec.minimumErrorCode ?? invalidParameterCode(key, spec),
		`${turnId}.${outcome} expects ${key} to be >= ${spec.minimum ?? 0}`,
	);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

type OutcomeParameterSchema = v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>;

const jsonObjectSchema = v.custom<Record<string, unknown>>(isJsonObject, "Expected an object");

function compileOutcomeParameterSchema(spec: OutcomeToolParameterSpec): OutcomeParameterSchema {
	switch (spec.type) {
		case "string":
			return v.string();
		case "number":
			return v.pipe(v.number(), v.finite());
		case "boolean":
			return v.boolean();
		case "object":
			return jsonObjectSchema;
		case "array": {
			const itemType = spec.items?.type ?? "string";
			const itemSchema: OutcomeParameterSchema =
				itemType === "string"
					? v.string()
					: itemType === "number"
						? v.pipe(v.number(), v.finite())
						: itemType === "boolean"
							? v.boolean()
							: jsonObjectSchema;
			return v.array(itemSchema);
		}
	}
}

function compileOutcomeParametersSchema(
	parameterSpecs: Record<string, OutcomeToolParameterSpec>,
): v.ObjectSchema<Record<string, OutcomeParameterSchema>, undefined> {
	return v.object(
		Object.fromEntries(
			Object.entries(parameterSpecs).map(([key, spec]) => {
				const schema = compileOutcomeParameterSchema(spec);
				return [key, spec.required ? schema : v.optional(schema)];
			}),
		),
	) as v.ObjectSchema<Record<string, OutcomeParameterSchema>, undefined>;
}

function effectiveArrayItemCount(
	spec: OutcomeToolParameterSpec,
	value: readonly unknown[],
): number {
	return (spec.items?.type ?? "string") === "string"
		? normalizeStringArray(value).length
		: value.length;
}

function expectedParameterLabel(spec: OutcomeToolParameterSpec): string {
	switch (spec.type) {
		case "string":
			return "a string";
		case "number":
			return "a finite number";
		case "boolean":
			return "a boolean";
		case "object":
			return "an object";
		case "array": {
			const itemType = spec.items?.type ?? "string";
			return `an array of ${
				itemType === "number"
					? "finite numbers"
					: itemType === "boolean"
						? "booleans"
						: itemType === "object"
							? "objects"
							: "strings"
			}`;
		}
	}
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
	outcome: string,
): OutcomeValidationContract | null {
	if (
		!turnDefinition ||
		(!isLlmTurnDefinition(turnDefinition) &&
			!isAutomaticTurnDefinition(turnDefinition) &&
			!isServerAutomaticTurnDefinition(turnDefinition))
	) {
		return null;
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

	return null;
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

	if (!turnDefinition) {
		return validationFailure(
			"turn_not_registered",
			`'${turnId}' is not registered in the loaded turn catalog`,
		);
	}

	if (
		!isLlmTurnDefinition(turnDefinition) &&
		!isAutomaticTurnDefinition(turnDefinition) &&
		!isServerAutomaticTurnDefinition(turnDefinition)
	) {
		return validationFailure(
			"turn_outcome_unsupported",
			`'${turnId}' does not support turn outcomes`,
		);
	}

	if (!resolveOutcomeValidationContract(turnDefinition, outcome)) {
		return validationFailure(
			"outcome_not_registered",
			`'${outcome}' is not registered for turn '${turnId}'`,
		);
	}

	return null;
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
	const parsed = v.safeParse(
		v.custom((value) => jsonValuesEqual(value, expectedParams)),
		params,
	);
	if (parsed.success) {
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
	const unknownKeys = Object.keys(params).filter((key) => !Object.hasOwn(parameterSpecs, key));
	if (unknownKeys.length > 0) {
		return validationFailure(
			"unknown_parameter",
			`${turnId}.${outcome} received unknown parameter(s): ${unknownKeys.join(", ")}`,
		);
	}

	const parsed = v.safeParse(compileOutcomeParametersSchema(parameterSpecs), params);
	for (const [key, spec] of Object.entries(parameterSpecs)) {
		const value = params[key];
		if (value === undefined) {
			if (spec.required) {
				return requiredParameterError(turnId, outcome, key, spec);
			}
			continue;
		}

		if (!v.safeParse(compileOutcomeParameterSchema(spec), value).success) {
			return invalidParameterError(turnId, outcome, key, spec, expectedParameterLabel(spec));
		}
		if (spec.type === "string" && trimString(value as string) === "" && spec.required) {
			return requiredParameterError(turnId, outcome, key, spec);
		}
		if (spec.type === "number" && spec.minimum !== undefined && (value as number) < spec.minimum) {
			return minimumParameterError(turnId, outcome, key, spec);
		}
		if (
			spec.enum &&
			spec.enum.length > 0 &&
			typeof value === "string" &&
			!spec.enum.includes(value)
		) {
			return invalidParameterError(turnId, outcome, key, spec, `one of: ${spec.enum.join(", ")}`);
		}
		if (spec.type === "array") {
			const effectiveItemCount = effectiveArrayItemCount(spec, value as readonly unknown[]);
			if (spec.required && effectiveItemCount === 0) {
				return requiredParameterError(turnId, outcome, key, spec);
			}
			if (spec.minItems !== undefined && effectiveItemCount < spec.minItems) {
				return minItemsParameterError(turnId, outcome, key, spec);
			}
		}
	}
	if (!parsed.success) {
		const issuePath = parsed.issues[0]?.path?.[0]?.key;
		const key = typeof issuePath === "string" ? issuePath : Object.keys(parameterSpecs)[0];
		const spec = key ? parameterSpecs[key] : undefined;
		if (key && spec) {
			return invalidParameterError(turnId, outcome, key, spec, expectedParameterLabel(spec));
		}
	}

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

	if (!turnDefinition) {
		return validationFailure(
			"turn_not_registered",
			`'${turnId}' is not registered in the loaded turn catalog`,
		);
	}

	if (
		!isLlmTurnDefinition(turnDefinition) &&
		!isAutomaticTurnDefinition(turnDefinition) &&
		!isServerAutomaticTurnDefinition(turnDefinition)
	) {
		return validationFailure(
			"turn_outcome_unsupported",
			`'${turnId}' does not support turn outcomes`,
		);
	}

	const contract = resolveOutcomeValidationContract(turnDefinition, outcome);
	if (!contract) {
		return validationFailure(
			"outcome_not_registered",
			`'${outcome}' is not registered for turn '${turnId}'`,
		);
	}

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
