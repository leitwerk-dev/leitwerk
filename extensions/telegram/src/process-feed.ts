import {
	formatPathTypeLabel,
	type ProcessInstance,
	type ProcessLeafOutcomeSnapshot,
	type ProcessLifecycleStatus,
	type ProcessTurnRecord,
	type ProcessTurnRecordPathType,
} from "@leitwerk-dev/domain";
import type { ProcessActionSummaryLike } from "@leitwerk-dev/process-sdk";
import {
	escapeTelegramHtml as escapeHtml,
	escapeTelegramAttribute,
	renderMarkdownToTelegramHtml,
} from "./markdown-html.js";

const MAX_SUBMITTED_FIELD_VALUE_CHARS = 500;

/**
 * Formats an internal turn ID (e.g. "generate_plan", "run_llm_review") into
 * a human-readable label by splitting on underscores / hyphens and capitalising
 * each word.
 */
export function formatTurnIdLabel(turnId: string): string {
	return turnId
		.split(/[_-]+/)
		.filter((part) => part.length > 0)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
		.join(" ");
}

type TelegramActionSummary = Pick<ProcessActionSummaryLike, "id" | "label" | "form"> & {
	preview?: {
		kind?: string;
		turnId?: string;
		lifecycleStatus?: string;
	} | null;
};

export function processLabel(process: ProcessInstance): string {
	return process.title?.trim() || process.externalId?.trim() || process.processId;
}

function actionLabel(action: Pick<ProcessActionSummaryLike, "id" | "label">): string {
	return action.label.trim() || action.id;
}

function actionListLines(
	actions: readonly Pick<ProcessActionSummaryLike, "id" | "label">[] = [],
	recoveryActions: readonly string[] = [],
): string[] {
	const labels = [
		...actions.map(actionLabel),
		...recoveryActions.map((label) => label.trim()).filter((label) => label.length > 0),
	];
	return labels.length > 0
		? ["Available actions:", ...labels.map((label) => `- ${escapeHtml(label)}`)]
		: [];
}

function stringifySubmittedFieldValue(value: unknown): string {
	if (typeof value === "string") return value.trim();
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) {
		return value
			.map((entry) => stringifySubmittedFieldValue(entry))
			.filter((entry) => entry.length > 0)
			.join(", ")
			.trim();
	}
	return "";
}

function trimSubmittedValue(value: string): string {
	return value.length > MAX_SUBMITTED_FIELD_VALUE_CHARS
		? `${value.slice(0, MAX_SUBMITTED_FIELD_VALUE_CHARS - 1)}…`
		: value;
}

function submittedActionFields(
	action: TelegramActionSummary,
	values: Record<string, unknown>,
): Array<{ label: string; value: string }> {
	const submittedFields: Array<{ label: string; value: string }> = [];
	const seenFieldIds = new Set<string>();
	for (const field of action.form?.fields ?? []) {
		seenFieldIds.add(field.id);
		const value = stringifySubmittedFieldValue(values[field.id]);
		if (value) submittedFields.push({ label: field.label, value: trimSubmittedValue(value) });
	}
	for (const [fieldId, rawValue] of Object.entries(values)) {
		if (seenFieldIds.has(fieldId)) continue;
		const value = stringifySubmittedFieldValue(rawValue);
		if (value) submittedFields.push({ label: fieldId, value: trimSubmittedValue(value) });
	}
	return submittedFields;
}

function actionNextLine(action: TelegramActionSummary): string {
	if (action.preview?.kind === "fixed_turn" && action.preview.turnId) {
		return `Next: running ${escapeHtml(action.preview.turnId)}; result will be posted here.`;
	}
	if (action.preview?.kind === "terminal" && action.preview.lifecycleStatus) {
		return `Next: process will become ${escapeHtml(action.preview.lifecycleStatus)}.`;
	}
	return "Next: the process will update shortly.";
}

export function buildProcessCreatedMessage(input: {
	process: ProcessInstance;
	serverBaseUrl: string;
}): string {
	const url = `${input.serverBaseUrl.replace(/\/$/, "")}/processes/${input.process.id}`;
	return [
		"🚀 <b>Process created</b>",
		`Title: ${escapeHtml(processLabel(input.process))}`,
		`Status: ${escapeHtml(input.process.lifecycleStatus)}`,
		`Web UI: <a href="${escapeTelegramAttribute(url)}">open process</a>`,
	].join("\n");
}

export function buildTurnStartedMessage(
	turnRecord: ProcessTurnRecord,
	options?: {
		turnDescription?: string | null;
		modelLabel?: string | null;
	},
): string {
	const description = options?.turnDescription?.trim() || turnRecord.turnId;
	const pathLabel = formatPathTypeLabel(turnRecord.pathType);
	const base = `▶️ <b>Started</b>: ${escapeHtml(description)} — ${escapeHtml(pathLabel)}`;
	const modelLabel = options?.modelLabel?.trim() ?? null;
	return modelLabel ? `${base} (model: ${escapeHtml(modelLabel)})` : base;
}

export function buildLeafOutcomeMessage(input: {
	snapshot: ProcessLeafOutcomeSnapshot;
	markdownHtml?: string;
}): string {
	const markdown = input.snapshot.fallbackMarkdown?.trim();
	if (!markdown) {
		return "✅ <b>Result available</b>\n\nOpen the Web UI for the full result.";
	}
	const body = input.markdownHtml ?? renderMarkdownToTelegramHtml(markdown);
	return body ? `✅ <b>Result</b>\n\n${body}` : "✅ <b>Result</b>";
}

export function buildTurnOutcomeMessage(input: {
	turnId: string;
	outcome: string;
	markdown: string;
	markdownHtml?: string;
	pathType?: ProcessTurnRecordPathType | null;
}): string {
	const pathSuffix = input.pathType ? ` (${escapeHtml(formatPathTypeLabel(input.pathType))})` : "";
	const heading = `✅ <b>Result</b>: ${escapeHtml(`${input.turnId}.${input.outcome}`)}${pathSuffix}`;
	const body = input.markdownHtml ?? renderMarkdownToTelegramHtml(input.markdown.trim());
	return body ? `${heading}\n\n${body}` : heading;
}

export function buildLifecycleMessage(input: {
	process: ProcessInstance;
	status: ProcessLifecycleStatus;
}): string | null {
	if (input.status === "completed") {
		return `🏁 <b>Completed</b>: ${escapeHtml(processLabel(input.process))}`;
	}
	if (input.status === "aborted") {
		return `🛑 <b>Aborted</b>: ${escapeHtml(processLabel(input.process))}`;
	}
	if (input.status === "error") {
		return `⚠️ <b>Process needs recovery</b>: ${escapeHtml(processLabel(input.process))}`;
	}
	return null;
}

export function buildActionsPromptMessage(input: {
	process: ProcessInstance;
	actions?: readonly Pick<ProcessActionSummaryLike, "id" | "label">[];
	recoveryActions?: readonly string[];
	currentTurnDescription?: string | null;
	currentTurnPathType?: ProcessTurnRecordPathType | null;
}): string {
	const rawTurn = input.currentTurnDescription?.trim() || input.process.selectedTurnId;
	const turnDisplay = rawTurn ? formatTurnIdLabel(rawTurn) : "none";
	const turnLine = `Turn: ${escapeHtml(turnDisplay)}`;
	const pathLine = input.currentTurnPathType
		? `Path: ${escapeHtml(formatPathTypeLabel(input.currentTurnPathType))}`
		: null;
	return [
		"⏸ <b>Action required</b>",
		"",
		`${escapeHtml(processLabel(input.process))}`,
		`Status: ${escapeHtml(input.process.lifecycleStatus)}`,
		turnLine,
		...(pathLine ? [pathLine] : []),
		...actionListLines(input.actions, input.recoveryActions),
	].join("\n");
}

export function buildStatusMessage(input: {
	process: ProcessInstance;
	actions?: readonly Pick<ProcessActionSummaryLike, "id" | "label">[];
	currentTurnDescription?: string | null;
	currentTurnPathType?: ProcessTurnRecordPathType | null;
}): string {
	const rawTurn = input.currentTurnDescription?.trim() || input.process.selectedTurnId;
	const turnDisplay = rawTurn ? formatTurnIdLabel(rawTurn) : "none";
	const turnLine = `Turn: ${escapeHtml(turnDisplay)}`;
	const pathLine = input.currentTurnPathType
		? `Path: ${escapeHtml(formatPathTypeLabel(input.currentTurnPathType))}`
		: null;
	const actionLines = actionListLines(input.actions);
	return [
		`<b>${escapeHtml(processLabel(input.process))}</b>`,
		`Status: ${escapeHtml(input.process.lifecycleStatus)}`,
		turnLine,
		...(pathLine ? [pathLine] : []),
		...(actionLines.length > 0 ? ["", ...actionLines] : []),
	].join("\n");
}

export function buildActionSubmittedMessage(input: {
	action: TelegramActionSummary;
	values: Record<string, unknown>;
}): string {
	const fields = submittedActionFields(input.action, input.values);
	return [
		`✅ <b>Submitted action</b>: ${escapeHtml(actionLabel(input.action))}`,
		...(fields.length > 0
			? [
					"Input:",
					...fields.map((field) => `- ${escapeHtml(field.label)}: ${escapeHtml(field.value)}`),
				]
			: ["Input: none"]),
		actionNextLine(input.action),
	].join("\n");
}
