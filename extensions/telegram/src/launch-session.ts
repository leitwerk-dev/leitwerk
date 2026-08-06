import {
	normalizeLaunchModelConfigInput,
	parseStrictInstanceTurnConfigsJson,
	trimToNull,
} from "@leitwerk-dev/domain";
import type {
	LauncherFieldDefinition,
	LauncherFieldOptionDefinition,
	LauncherModelConfigPreviewLike,
	LauncherModelConfigSchemaLike,
	LauncherValidationError,
	LaunchModelConfigInputLike,
	ProcessLaunchPlan,
	UiLauncherSummary,
} from "@leitwerk-dev/process-sdk";

export type LaunchFieldValue = string | number | boolean;

export type LaunchModelStep =
	| { kind: "default"; key: "default"; label: string }
	| { kind: "turn"; key: string; turnId: string; label: string };

export interface PendingLaunchModelEdit {
	stepIndex: number;
}

export interface PendingLaunchSession {
	kind: "launch";
	launcherId: string;
	fieldIndex: number;
	fieldOrder: readonly string[];
	values: Record<string, LaunchFieldValue>;
	modelConfig: LaunchModelConfigInputLike;
	modelConfigTouched: boolean;
	modelEdit: PendingLaunchModelEdit | null;
	expiresAt: number;
}

export type LaunchFieldStepResult =
	| { ok: true; done: false; field: LauncherFieldDefinition }
	| { ok: true; done: true; values: Record<string, LaunchFieldValue> }
	| { ok: false; prompt: string };

export type LaunchModelStepResult =
	| { ok: true; done: false; step: LaunchModelStep }
	| { ok: true; done: true }
	| { ok: false; prompt: string };

export type LaunchModelStepAction =
	| { action: "set"; value: string }
	| { action: "inherit" }
	| { action: "skip" };

export type LaunchFieldOptionsById = Record<
	string,
	readonly LauncherFieldOptionDefinition[] | undefined
>;

export function createLaunchSession(input: {
	launcher: UiLauncherSummary;
	defaults?: Record<string, unknown>;
	now?: number;
	ttlMs?: number;
}): PendingLaunchSession {
	const values: Record<string, LaunchFieldValue> = {};
	for (const field of input.launcher.launchConfigSchema.fields) {
		const normalized = normalizeFieldValue(field, input.defaults?.[field.id]);
		if (normalized.ok) {
			values[field.id] = normalized.value;
		}
	}
	return {
		kind: "launch",
		launcherId: input.launcher.id,
		fieldIndex: 0,
		fieldOrder: buildFieldOrder(input.launcher),
		values,
		modelConfig: { defaultModelProfileId: null, turnConfigs: {} },
		modelConfigTouched: false,
		modelEdit: null,
		expiresAt: (input.now ?? Date.now()) + (input.ttlMs ?? 20 * 60 * 1000),
	};
}

export function buildLaunchInput(session: PendingLaunchSession): Record<string, unknown> {
	return { ...session.values };
}

export function buildLaunchModelConfig(session: PendingLaunchSession): LaunchModelConfigInputLike {
	return normalizeLaunchModelConfigInput(session.modelConfig);
}

export function seedLaunchModelConfigFromPlan(
	session: PendingLaunchSession,
	launchPlan: ProcessLaunchPlan,
): void {
	if (session.modelConfigTouched) return;
	const parsedTurnConfigs = parseStrictInstanceTurnConfigsJson(
		launchPlan.processId,
		launchPlan.processInput.turnConfigsJson,
	);
	session.modelConfig = normalizeLaunchModelConfigInput({
		defaultModelProfileId: launchPlan.processInput.defaultModelProfileId ?? null,
		turnConfigs: parsedTurnConfigs.ok ? parsedTurnConfigs.value : {},
	});
}

export function hasLaunchModelControls(
	schema: LauncherModelConfigSchemaLike | null | undefined,
): schema is LauncherModelConfigSchemaLike {
	return Boolean(schema && schema.availableProfiles.length > 0 && schema.llmTurns.length > 0);
}

function buildLaunchModelStepOrder(schema: LauncherModelConfigSchemaLike): LaunchModelStep[] {
	return [
		{ kind: "default", key: "default", label: "Default model" },
		...schema.llmTurns.map((turn) => ({
			kind: "turn" as const,
			key: `turn:${turn.turnId}`,
			turnId: turn.turnId,
			label: turn.description || turn.turnId,
		})),
	];
}

export function beginLaunchModelEdit(
	session: PendingLaunchSession,
	schema: LauncherModelConfigSchemaLike,
): LaunchModelStepResult {
	session.modelEdit = { stepIndex: 0 };
	return { ok: true, done: false, step: buildLaunchModelStepOrder(schema)[0] as LaunchModelStep };
}

export function currentLaunchModelStep(
	session: PendingLaunchSession,
	schema: LauncherModelConfigSchemaLike,
): LaunchModelStep | null {
	if (!session.modelEdit) return null;
	return buildLaunchModelStepOrder(schema)[session.modelEdit.stepIndex] ?? null;
}

export function finishLaunchModelEdit(session: PendingLaunchSession): void {
	session.modelEdit = null;
}

export function currentLaunchField(
	session: PendingLaunchSession,
	launcher: UiLauncherSummary,
): LauncherFieldDefinition | null {
	const fieldId = session.fieldOrder[session.fieldIndex];
	return fieldId
		? (launcher.launchConfigSchema.fields.find((field) => field.id === fieldId) ?? null)
		: null;
}

export function isLaunchSessionComplete(session: PendingLaunchSession): boolean {
	return session.fieldIndex >= session.fieldOrder.length;
}

export function getLaunchFieldOptions(
	field: LauncherFieldDefinition,
	dynamicOptionsById: LaunchFieldOptionsById,
): readonly LauncherFieldOptionDefinition[] {
	if (field.kind !== "select") return [];
	return dynamicOptionsById[field.id] ?? field.options ?? [];
}

export function buildLaunchFieldPrompt(input: {
	field: LauncherFieldDefinition;
	currentValue?: LaunchFieldValue;
	options?: readonly LauncherFieldOptionDefinition[];
	recentValues?: readonly string[];
	maxOptionsInPrompt?: number;
}): string {
	const { field } = input;
	const lines = [`${field.required ? "Required" : "Optional"} field: ${field.label}`];
	if (field.description?.trim()) lines.push(field.description.trim());
	const current = formatLaunchFieldValue(input.currentValue);
	if (current) lines.push(`Current/default: ${current}`);
	if (field.kind === "boolean") {
		lines.push("Reply yes or no, or use the buttons.");
	} else if (field.kind === "number") {
		lines.push("Reply with a number.");
	} else if (field.kind === "select") {
		const options = input.options ?? [];
		if (options.length > 0) {
			lines.push("Choose one option by button, number, value, or label:");
			const max = input.maxOptionsInPrompt ?? 12;
			for (const [index, option] of options.slice(0, max).entries()) {
				lines.push(
					`${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`,
				);
			}
			if (options.length > max) {
				lines.push(`…and ${options.length - max} more. Use a button or type the exact value.`);
			}
		} else {
			lines.push("Reply with a value for this field.");
		}
	} else if (input.recentValues?.length) {
		lines.push("Choose a recent value or reply with a different value.");
	} else {
		lines.push("Reply with the value for this field.");
	}
	if (!field.required || hasPresentValue(input.currentValue)) {
		lines.push("Send /skip to keep the current/default value or leave it blank.");
	}
	return lines.join("\n");
}

export function buildLaunchModelSummary(input: {
	schema: LauncherModelConfigSchemaLike;
	session: PendingLaunchSession;
	preview?: LauncherModelConfigPreviewLike | null;
}): string {
	const config = buildLaunchModelConfig(input.session);
	const lines = ["Model setup:"];
	const defaultProfileId = trimToNull(config.defaultModelProfileId);
	const defaultPreview = input.preview?.defaultModel.profile;
	lines.push(
		`- Default: ${defaultProfileId ? formatLaunchModelProfile(input.schema, defaultProfileId) : (defaultPreview?.label ?? "inherited/recommended")}${
			defaultProfileId ? " (override)" : ""
		}`,
	);
	for (const turn of input.schema.llmTurns) {
		const override = trimToNull(config.turnConfigs?.[turn.turnId]?.modelProfileId);
		const preview = input.preview?.turns.find((candidate) => candidate.turnId === turn.turnId);
		lines.push(
			`- ${turn.description || turn.turnId}: ${override ? formatLaunchModelProfile(input.schema, override) : (preview?.effective.profile?.label ?? "inherited/recommended")}${
				override ? " (override)" : ""
			}`,
		);
	}
	return lines.join("\n");
}

export function buildLaunchModelStepPrompt(input: {
	step: LaunchModelStep;
	schema: LauncherModelConfigSchemaLike;
	session: PendingLaunchSession;
	preview?: LauncherModelConfigPreviewLike | null;
	maxOptionsInPrompt?: number;
}): string {
	const currentOverride = getLaunchModelStepOverride(input.session, input.step);
	const effective = getLaunchModelStepPreview(input.preview, input.step);
	const lines = [`Model setup: ${input.step.label}`];
	lines.push(
		`Current override: ${currentOverride ? formatLaunchModelProfile(input.schema, currentOverride) : "inherited/recommended"}`,
	);
	if (effective) lines.push(`Effective now: ${effective}`);
	lines.push("Choose a model by button, number, or profile id.");
	const max = input.maxOptionsInPrompt ?? 12;
	for (const [index, profile] of input.schema.availableProfiles.slice(0, max).entries()) {
		lines.push(`${index + 1}. ${profile.label}`);
	}
	if (input.schema.availableProfiles.length > max) {
		lines.push(
			`…and ${input.schema.availableProfiles.length - max} more. Use a button or type the exact profile id.`,
		);
	}
	lines.push("Send /skip to keep this value, or use Inherit to clear an override.");
	return lines.join("\n");
}

export function applyLaunchModelStepText(
	session: PendingLaunchSession,
	schema: LauncherModelConfigSchemaLike,
	text: string,
): LaunchModelStepResult {
	const step = currentLaunchModelStep(session, schema);
	if (!step) return { ok: true, done: true };
	const trimmed = text.trim();
	const normalized = trimmed.toLowerCase();
	if (/^\/skip(?:@\w+)?$/i.test(trimmed) || normalized === "skip" || !trimmed) {
		return applyLaunchModelStepAction(session, schema, { action: "skip" });
	}
	if (["inherit", "inherited", "clear", "none"].includes(normalized)) {
		return applyLaunchModelStepAction(session, schema, { action: "inherit" });
	}
	const matched = matchModelProfile(trimmed, schema);
	return matched
		? applyLaunchModelStepAction(session, schema, { action: "set", value: matched.id })
		: launchModelStepError(step, schema, session);
}

export function applyLaunchModelStepAction(
	session: PendingLaunchSession,
	schema: LauncherModelConfigSchemaLike,
	action: LaunchModelStepAction,
): LaunchModelStepResult {
	const step = currentLaunchModelStep(session, schema);
	if (!step) return { ok: true, done: true };
	if (action.action === "skip") return advanceLaunchModelStep(session, schema);
	if (action.action === "inherit") {
		clearLaunchModelStepOverride(session, step);
		return advanceLaunchModelStep(session, schema);
	}
	const matched = schema.availableProfiles.find((profile) => profile.id === action.value);
	if (!matched) return launchModelStepError(step, schema, session);
	setLaunchModelStepOverride(session, step, matched.id);
	return advanceLaunchModelStep(session, schema);
}

export function applyLaunchFieldText(
	session: PendingLaunchSession,
	launcher: UiLauncherSummary,
	text: string,
	dynamicOptionsById: LaunchFieldOptionsById = {},
): LaunchFieldStepResult {
	const field = currentLaunchField(session, launcher);
	if (!field) {
		return {
			ok: true,
			done: true,
			values: buildLaunchInput(session) as Record<string, LaunchFieldValue>,
		};
	}
	const options = getLaunchFieldOptions(field, dynamicOptionsById);
	const trimmed = text.trim();
	const wantsSkip = /^\/skip(?:@\w+)?$/i.test(trimmed) || trimmed.toLowerCase() === "skip";
	const parsed = wantsSkip
		? skipField(field, session.values[field.id])
		: parseFieldText(field, text, options);
	if (!parsed.ok) {
		return {
			ok: false,
			prompt: `${parsed.error}\n${buildLaunchFieldPrompt({ field, currentValue: session.values[field.id], options })}`,
		};
	}
	if (parsed.setValue) {
		session.values[field.id] = parsed.value;
	}
	session.fieldIndex += 1;
	const next = currentLaunchField(session, launcher);
	return next
		? { ok: true, done: false, field: next }
		: {
				ok: true,
				done: true,
				values: buildLaunchInput(session) as Record<string, LaunchFieldValue>,
			};
}

export function applyLaunchFieldValue(
	session: PendingLaunchSession,
	launcher: UiLauncherSummary,
	value: unknown,
	dynamicOptionsById: LaunchFieldOptionsById = {},
): LaunchFieldStepResult {
	const field = currentLaunchField(session, launcher);
	if (!field) {
		return {
			ok: true,
			done: true,
			values: buildLaunchInput(session) as Record<string, LaunchFieldValue>,
		};
	}
	const parsed = normalizeFieldValue(field, value);
	if (!parsed.ok || (field.required && !hasPresentValue(parsed.value))) {
		const options = getLaunchFieldOptions(field, dynamicOptionsById);
		return {
			ok: false,
			prompt: `${parsed.ok ? `${field.label} is required.` : parsed.error}\n${buildLaunchFieldPrompt({ field, currentValue: session.values[field.id], options })}`,
		};
	}
	session.values[field.id] = parsed.value;
	session.fieldIndex += 1;
	const next = currentLaunchField(session, launcher);
	return next
		? { ok: true, done: false, field: next }
		: {
				ok: true,
				done: true,
				values: buildLaunchInput(session) as Record<string, LaunchFieldValue>,
			};
}

export function moveLaunchSessionToValidationField(
	session: PendingLaunchSession,
	launcher: UiLauncherSummary,
	errors: readonly LauncherValidationError[],
): LauncherFieldDefinition | null {
	const fieldId = errors.find((error) => error.fieldId)?.fieldId;
	if (!fieldId) return null;
	const field = launcher.launchConfigSchema.fields.find((candidate) => candidate.id === fieldId);
	if (!field) return null;
	const index = session.fieldOrder.indexOf(fieldId);
	if (index < 0) return null;
	session.fieldIndex = index;
	return field;
}

function buildFieldOrder(launcher: UiLauncherSummary): string[] {
	const fields = launcher.launchConfigSchema.fields;
	return [
		...fields.filter((field) => field.required).map((field) => field.id),
		...fields.filter((field) => !field.required).map((field) => field.id),
	];
}

export function buildLaunchReview(input: {
	launcher: UiLauncherSummary;
	session: PendingLaunchSession;
}): string {
	const lines = [`Ready to start ${input.launcher.label}.`, "", "Launcher config:"];
	for (const field of input.launcher.launchConfigSchema.fields) {
		lines.push(
			`- ${field.label}: ${formatLaunchFieldValue(input.session.values[field.id]) || "(empty)"}`,
		);
	}
	lines.push("", "Use Start process to launch, or Cancel to discard this draft.");
	return lines.join("\n");
}

function formatLaunchModelProfile(
	schema: LauncherModelConfigSchemaLike,
	modelProfileId: string,
): string {
	return (
		schema.availableProfiles.find((profile) => profile.id === modelProfileId)?.label ??
		modelProfileId
	);
}

function getLaunchModelStepOverride(
	session: PendingLaunchSession,
	step: LaunchModelStep,
): string | null {
	const config = buildLaunchModelConfig(session);
	return step.kind === "default"
		? (trimToNull(config.defaultModelProfileId) ?? null)
		: (trimToNull(config.turnConfigs?.[step.turnId]?.modelProfileId) ?? null);
}

function getLaunchModelStepPreview(
	preview: LauncherModelConfigPreviewLike | null | undefined,
	step: LaunchModelStep,
): string | null {
	if (!preview) return null;
	if (step.kind === "default") return preview.defaultModel.profile?.label ?? null;
	return (
		preview.turns.find((turn) => turn.turnId === step.turnId)?.effective.profile?.label ?? null
	);
}

function launchModelStepError(
	step: LaunchModelStep,
	schema: LauncherModelConfigSchemaLike,
	session: PendingLaunchSession,
): LaunchModelStepResult {
	return {
		ok: false,
		prompt: `${step.label} must match an available model profile.\n${buildLaunchModelStepPrompt({ step, schema, session })}`,
	};
}

function matchModelProfile(
	text: string,
	schema: LauncherModelConfigSchemaLike,
): LauncherModelConfigSchemaLike["availableProfiles"][number] | null {
	return matchByNumberValueOrLabel(text, schema.availableProfiles, (profile) => profile.id);
}

function setLaunchModelStepOverride(
	session: PendingLaunchSession,
	step: LaunchModelStep,
	modelProfileId: string,
): void {
	const current = buildLaunchModelConfig(session);
	if (step.kind === "default") {
		session.modelConfig = {
			...current,
			defaultModelProfileId: modelProfileId,
			turnConfigs: current.turnConfigs ?? {},
		};
	} else {
		session.modelConfig = {
			...current,
			turnConfigs: {
				...(current.turnConfigs ?? {}),
				[step.turnId]: { modelProfileId },
			},
		};
	}
	session.modelConfigTouched = true;
}

function clearLaunchModelStepOverride(session: PendingLaunchSession, step: LaunchModelStep): void {
	const current = buildLaunchModelConfig(session);
	if (step.kind === "default") {
		session.modelConfig = {
			...current,
			defaultModelProfileId: null,
			turnConfigs: current.turnConfigs ?? {},
		};
	} else {
		const turnConfigs = { ...(current.turnConfigs ?? {}) };
		delete turnConfigs[step.turnId];
		session.modelConfig = { ...current, turnConfigs };
	}
	session.modelConfigTouched = true;
}

function advanceLaunchModelStep(
	session: PendingLaunchSession,
	schema: LauncherModelConfigSchemaLike,
): LaunchModelStepResult {
	if (!session.modelEdit) return { ok: true, done: true };
	session.modelEdit = { stepIndex: session.modelEdit.stepIndex + 1 };
	const next = currentLaunchModelStep(session, schema);
	if (next) return { ok: true, done: false, step: next };
	finishLaunchModelEdit(session);
	return { ok: true, done: true };
}

function parseBoolean(value: string): boolean | null {
	const normalized = value.trim().toLowerCase();
	if (["yes", "y", "true", "1", "on"].includes(normalized)) return true;
	if (["no", "n", "false", "0", "off"].includes(normalized)) return false;
	return null;
}

function hasPresentValue(value: unknown): boolean {
	if (typeof value === "string") return value.trim() !== "";
	if (typeof value === "number") return Number.isFinite(value);
	if (typeof value === "boolean") return true;
	return false;
}

function formatLaunchFieldValue(value: unknown): string {
	if (typeof value === "string") return value.trim();
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	if (typeof value === "boolean") return value ? "yes" : "no";
	return "";
}

function normalizeFieldValue(
	field: LauncherFieldDefinition,
	value: unknown,
): { ok: true; value: LaunchFieldValue } | { ok: false; error: string } {
	if (value === undefined || value === null)
		return { ok: false, error: `${field.label} is required.` };
	if (field.kind === "boolean") {
		if (typeof value === "boolean") return { ok: true, value };
		if (typeof value === "string") {
			const parsed = parseBoolean(value);
			if (parsed !== null) return { ok: true, value: parsed };
		}
		return { ok: false, error: `${field.label} must be yes or no.` };
	}
	if (field.kind === "number") {
		const parsed = typeof value === "number" ? value : Number(String(value).trim());
		return Number.isFinite(parsed)
			? { ok: true, value: parsed }
			: { ok: false, error: `${field.label} must be a number.` };
	}
	return { ok: true, value: String(value) };
}

function skipField(
	field: LauncherFieldDefinition,
	currentValue: LaunchFieldValue | undefined,
): { ok: true; setValue: boolean; value: LaunchFieldValue } | { ok: false; error: string } {
	if (hasPresentValue(currentValue)) {
		return { ok: true, setValue: false, value: currentValue as LaunchFieldValue };
	}
	if (field.required) {
		return { ok: false, error: `${field.label} is required.` };
	}
	return { ok: true, setValue: true, value: field.kind === "boolean" ? false : "" };
}

function parseFieldText(
	field: LauncherFieldDefinition,
	text: string,
	options: readonly LauncherFieldOptionDefinition[],
): { ok: true; setValue: boolean; value: LaunchFieldValue } | { ok: false; error: string } {
	const trimmed = text.trim();
	if (!trimmed) {
		return skipField(field, undefined);
	}
	if (field.kind === "select") {
		const matched = matchSelectOption(trimmed, options);
		if (matched) return { ok: true, setValue: true, value: matched.value };
		if (options.length > 0) {
			return { ok: false, error: `${field.label} must match one of the available options.` };
		}
		return { ok: true, setValue: true, value: trimmed };
	}
	const normalized = normalizeFieldValue(field, text);
	if (!normalized.ok) return normalized;
	if (field.required && !hasPresentValue(normalized.value)) {
		return { ok: false, error: `${field.label} is required.` };
	}
	return { ok: true, setValue: true, value: normalized.value };
}

function matchSelectOption(
	text: string,
	options: readonly LauncherFieldOptionDefinition[],
): LauncherFieldOptionDefinition | null {
	return matchByNumberValueOrLabel(text, options, (option) => option.value);
}

function matchByNumberValueOrLabel<T extends { label: string }>(
	text: string,
	options: readonly T[],
	getValue: (item: T) => string,
): T | null {
	const numeric = Number(text);
	if (Number.isInteger(numeric) && numeric >= 1 && numeric <= options.length) {
		return options[numeric - 1] ?? null;
	}
	const lower = text.toLowerCase();
	return (
		options.find((option) => getValue(option) === text) ??
		options.find((option) => option.label.toLowerCase() === lower) ??
		null
	);
}
