import type { ProcessActionDefinition } from "@leitwerk-dev/process-sdk";

function describeFieldType(
	kind: NonNullable<ProcessActionDefinition["form"]>["fields"][number]["kind"],
): string {
	switch (kind) {
		case "textarea":
			return "string";
		case "text":
			return "string";
		default:
			return kind;
	}
}

export interface ProcessActionInputValidationFailure {
	ok: false;
	code: "invalid_action_input";
	error: string;
}

export function validateProcessActionInput(
	action: ProcessActionDefinition,
	input: Record<string, unknown>,
): ProcessActionInputValidationFailure | null {
	if (!action.form) {
		return null;
	}
	for (const field of action.form.fields) {
		const rawValue = input[field.id];
		if (field.required) {
			if (field.kind === "boolean") {
				if (rawValue !== true) {
					return {
						ok: false,
						code: "invalid_action_input",
						error: `Field '${field.id}' must be true`,
					};
				}
			} else if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") {
				return {
					ok: false,
					code: "invalid_action_input",
					error: `Field '${field.id}' is required`,
				};
			}
		}
		if (rawValue === undefined || rawValue === null || rawValue === "") {
			continue;
		}
		if (field.kind === "text" || field.kind === "textarea") {
			if (typeof rawValue !== "string") {
				return {
					ok: false,
					code: "invalid_action_input",
					error: `Field '${field.id}' must be a ${describeFieldType(field.kind)}`,
				};
			}
			continue;
		}
		if (field.kind === "boolean") {
			if (typeof rawValue !== "boolean") {
				return {
					ok: false,
					code: "invalid_action_input",
					error: `Field '${field.id}' must be a boolean`,
				};
			}
			continue;
		}
		if (field.kind === "number") {
			const parsed =
				typeof rawValue === "number"
					? rawValue
					: typeof rawValue === "string"
						? Number(rawValue.trim())
						: Number.NaN;
			if (!Number.isFinite(parsed)) {
				return {
					ok: false,
					code: "invalid_action_input",
					error: `Field '${field.id}' must be a number`,
				};
			}
		}
	}
	return null;
}
