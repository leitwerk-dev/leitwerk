import type { LauncherFieldDefinition, LauncherValidationError } from "../lib/api.js";

export interface LauncherDefaultsNotice {
	tone: "warning";
	title: string;
	message: string;
	fieldIds: readonly string[];
	details: readonly string[];
}

export interface LauncherValidationView {
	fieldErrors: Record<string, string[]>;
	formErrors: string[];
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildFieldLookup(
	fields: readonly LauncherFieldDefinition[],
): Record<string, LauncherFieldDefinition> {
	return Object.fromEntries(fields.map((field) => [field.id, field]));
}

function getNoticeFieldLabel(field: LauncherFieldDefinition): string {
	if (field.id === "repoLocator") {
		return "Repository path or URL";
	}
	return field.label;
}

function replaceFieldIdsWithLabels(
	message: string,
	fieldLookup: Record<string, LauncherFieldDefinition>,
): string {
	let nextMessage = message;
	for (const [fieldId, field] of Object.entries(fieldLookup).sort(
		([leftId], [rightId]) => rightId.length - leftId.length,
	)) {
		nextMessage = nextMessage.replace(
			new RegExp(`\\b${escapeRegExp(fieldId)}\\b`, "g"),
			getNoticeFieldLabel(field),
		);
	}
	return nextMessage;
}

function isBlankLauncherFieldValue(value: unknown): boolean {
	if (typeof value === "string") {
		return value.trim() === "";
	}
	return value == null;
}

function pushUnique(target: string[], value: string) {
	if (!target.includes(value)) {
		target.push(value);
	}
}

export function humanizeLauncherValidationMessage(
	fields: readonly LauncherFieldDefinition[],
	error: LauncherValidationError,
): string {
	const fieldLookup = buildFieldLookup(fields);
	const field = typeof error.fieldId === "string" ? fieldLookup[error.fieldId] : undefined;

	if (field && error.code === "required") {
		return "Required.";
	}

	if (field?.id === "repoLocator" && error.code === "invalid_repo_locator") {
		return "Use a local path or remote Git URL.";
	}

	const replacedMessage = replaceFieldIdsWithLabels(error.message, fieldLookup).trim();
	if (replacedMessage === "") {
		return "Check this field.";
	}
	return replacedMessage;
}

export function normalizeLauncherValidationErrors(
	fields: readonly LauncherFieldDefinition[],
	errors: readonly LauncherValidationError[],
): LauncherValidationView {
	const nextFieldErrors: Record<string, string[]> = {};
	const nextFormErrors: string[] = [];

	for (const error of errors) {
		const message = humanizeLauncherValidationMessage(fields, error);
		if (typeof error.fieldId === "string" && error.fieldId.trim() !== "") {
			const fieldId = error.fieldId.trim();
			nextFieldErrors[fieldId] = nextFieldErrors[fieldId] ?? [];
			pushUnique(nextFieldErrors[fieldId], message);
			continue;
		}
		pushUnique(nextFormErrors, message);
	}

	return {
		fieldErrors: nextFieldErrors,
		formErrors: nextFormErrors,
	};
}

export function getFirstLauncherFieldIdWithErrors(
	fields: readonly LauncherFieldDefinition[],
	fieldErrors: Record<string, readonly string[]>,
): string | null {
	for (const field of fields) {
		if ((fieldErrors[field.id]?.length ?? 0) > 0) {
			return field.id;
		}
	}
	for (const fieldId of Object.keys(fieldErrors)) {
		if ((fieldErrors[fieldId]?.length ?? 0) > 0) {
			return fieldId;
		}
	}
	return null;
}

export function buildLauncherDefaultsNotice(input: {
	fields: readonly LauncherFieldDefinition[];
	values: Record<string, unknown>;
	warnings: readonly LauncherValidationError[];
}): LauncherDefaultsNotice | null {
	if (input.warnings.length === 0) {
		return null;
	}

	const fieldLookup = buildFieldLookup(input.fields);
	const setupFieldIds: string[] = [];
	let isPureSetupState = true;

	for (const warning of input.warnings) {
		if (typeof warning.fieldId !== "string" || warning.fieldId.trim() === "") {
			isPureSetupState = false;
			continue;
		}
		const fieldId = warning.fieldId.trim();
		const field = fieldLookup[fieldId];
		if (!field || field.required !== true || !isBlankLauncherFieldValue(input.values[fieldId])) {
			isPureSetupState = false;
			continue;
		}
		pushUnique(setupFieldIds, fieldId);
	}

	if (isPureSetupState && setupFieldIds.length > 0) {
		return null;
	}

	const details: string[] = [];
	const warningFieldIds: string[] = [];
	for (const warning of input.warnings) {
		pushUnique(details, humanizeLauncherValidationMessage(input.fields, warning));
		if (typeof warning.fieldId === "string" && warning.fieldId.trim() !== "") {
			pushUnique(warningFieldIds, warning.fieldId.trim());
		}
	}

	return {
		tone: "warning",
		title: "We adjusted some starter values",
		message: "Review the highlighted details before you launch.",
		fieldIds: warningFieldIds,
		details,
	};
}
