import {
	emptyQuestionDrafts,
	type ProcessQuestionRequest,
	type QuestionAnswerDraft,
} from "@leitwerk-dev/domain";
import type {
	FormDefinition,
	FormFieldDefinition,
	ModelProfileOptionSummaryLike,
	ProcessActionModelPreviewLike,
} from "@leitwerk-dev/process-sdk";
import { resolvePromptCacheSwitch } from "@leitwerk-dev/protocol/http-contracts";

export interface ActionPreviewLike {
	kind?: string;
	turnId?: string;
	lifecycleStatus?: string;
}

export type PendingTelegramSession =
	| {
			kind: "action_form";
			instanceId: string;
			actionId: string;
			actionLabel: string;
			actionPreview?: ActionPreviewLike | null;
			sessionId: string;
			form: FormDefinition;
			fieldIndex: number;
			values: Record<string, unknown>;
			expiresAt: number;
	  }
	| {
			kind: "action_model";
			instanceId: string;
			actionId: string;
			actionLabel: string;
			actionPreview?: ActionPreviewLike | null;
			sessionId: string;
			formValues: Record<string, unknown>;
			preview: ProcessActionModelPreviewLike;
			profiles: readonly ModelProfileOptionSummaryLike[];
			expiresAt: number;
	  }
	| {
			kind: "recovery_model";
			instanceId: string;
			recoveryKind: "retry" | "continue";
			turnRecordId?: string;
			sessionId: string;
			profiles: readonly ModelProfileOptionSummaryLike[];
			selectedModelProfileId?: string | null;
			expiresAt: number;
	  }
	| {
			kind: "continue";
			instanceId: string;
			turnRecordId: string;
			nextTurnModelProfileId?: string | null;
			expiresAt: number;
	  }
	| {
			kind: "question";
			instanceId: string;
			request: ProcessQuestionRequest;
			questionIndex: number;
			draft: QuestionAnswerDraft[];
			expiresAt: number;
	  };

export type PendingActionFormSession = Extract<PendingTelegramSession, { kind: "action_form" }>;
export type PendingActionModelSession = Extract<PendingTelegramSession, { kind: "action_model" }>;
export type PendingQuestionSession = Extract<PendingTelegramSession, { kind: "question" }>;

export type FormStepResult =
	| { ok: true; done: false; prompt: string }
	| { ok: true; done: true; values: Record<string, unknown> }
	| { ok: false; prompt: string };

export function buildActionFormSession(input: {
	instanceId: string;
	actionId: string;
	actionLabel?: string;
	actionPreview?: ActionPreviewLike | null;
	sessionId: string;
	form: FormDefinition;
	now?: number;
	ttlMs?: number;
}): PendingActionFormSession {
	return {
		kind: "action_form",
		instanceId: input.instanceId,
		actionId: input.actionId,
		actionLabel: input.actionLabel ?? input.actionId,
		actionPreview: input.actionPreview ?? null,
		sessionId: input.sessionId,
		form: input.form,
		fieldIndex: 0,
		values: {},
		expiresAt: (input.now ?? Date.now()) + (input.ttlMs ?? 10 * 60 * 1000),
	};
}

export function buildQuestionSession(input: {
	instanceId: string;
	request: ProcessQuestionRequest;
}): PendingQuestionSession {
	return {
		kind: "question",
		instanceId: input.instanceId,
		request: input.request,
		questionIndex: 0,
		draft: emptyQuestionDrafts(input.request.questions),
		expiresAt: Number.POSITIVE_INFINITY,
	};
}

export function buildQuestionPrompt(session: PendingQuestionSession): string {
	const question = session.request.questions[session.questionIndex];
	if (!question) return "Send your answer.";
	const options = question.options.map(
		(option) => `• ${option.label}${option.details ? ` — ${option.details}` : ""}`,
	);
	return [
		`❓ Question ${session.questionIndex + 1} of ${session.request.questions.length}`,
		question.question,
		...options,
		"Reply with your answer in free text.",
	].join("\n");
}

export function applyQuestionText(
	session: PendingQuestionSession,
	text: string,
): { done: boolean; draft: QuestionAnswerDraft[]; prompt?: string } {
	const answer = session.draft[session.questionIndex];
	if (!answer || text.trim() === "") {
		return {
			done: false,
			draft: session.draft,
			prompt: `Answer must not be empty.\n${buildQuestionPrompt(session)}`,
		};
	}
	answer.freeText = text.trim();
	session.questionIndex += 1;
	return session.questionIndex < session.request.questions.length
		? { done: false, draft: session.draft, prompt: buildQuestionPrompt(session) }
		: { done: true, draft: session.draft };
}

export function buildContinueSession(input: {
	instanceId: string;
	turnRecordId: string;
	nextTurnModelProfileId?: string | null;
	now?: number;
	ttlMs?: number;
}): Extract<PendingTelegramSession, { kind: "continue" }> {
	return {
		kind: "continue",
		instanceId: input.instanceId,
		turnRecordId: input.turnRecordId,
		nextTurnModelProfileId: input.nextTurnModelProfileId ?? null,
		expiresAt: (input.now ?? Date.now()) + (input.ttlMs ?? 10 * 60 * 1000),
	};
}

export function currentField(session: PendingActionFormSession): FormFieldDefinition | null {
	return session.form.fields[session.fieldIndex] ?? null;
}

export function buildFieldPrompt(field: FormFieldDefinition): string {
	const required = field.required ? " required" : "";
	const description = field.description ? `\n${field.description}` : "";
	const hint = field.placeholder ? `\nHint: ${field.placeholder}` : "";
	return `Enter ${field.label}${required}.${description}${hint}`;
}

export function canSkipActionFormField(field: FormFieldDefinition | null | undefined): boolean {
	return Boolean(field && !field.required);
}

function advanceFormField(session: PendingActionFormSession): FormStepResult {
	session.fieldIndex += 1;
	const field = currentField(session);
	return field
		? { ok: true, done: false, prompt: buildFieldPrompt(field) }
		: { ok: true, done: true, values: session.values };
}

export function applyFormSkip(session: PendingActionFormSession): FormStepResult {
	const field = currentField(session);
	if (!field) {
		return { ok: true, done: true, values: session.values };
	}
	if (!canSkipActionFormField(field)) {
		return { ok: false, prompt: `${field.label} is required.\n${buildFieldPrompt(field)}` };
	}
	return advanceFormField(session);
}

function parseBoolean(value: string): boolean | null {
	const normalized = value.trim().toLowerCase();
	if (["yes", "y", "true", "1"].includes(normalized)) return true;
	if (["no", "n", "false", "0"].includes(normalized)) return false;
	return null;
}

function parseFieldValue(
	field: FormFieldDefinition,
	text: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
	const trimmed = text.trim();
	if (!trimmed && field.required) {
		return { ok: false, error: `${field.label} is required.` };
	}
	if (!trimmed) {
		return { ok: true, value: "" };
	}
	if (field.kind === "number") {
		const value = Number(trimmed);
		return Number.isFinite(value)
			? { ok: true, value }
			: { ok: false, error: `${field.label} must be a number.` };
	}
	if (field.kind === "boolean") {
		const value = parseBoolean(trimmed);
		return value === null
			? { ok: false, error: `${field.label} must be yes or no.` }
			: { ok: true, value };
	}
	return { ok: true, value: text };
}

export function applyFormText(session: PendingActionFormSession, text: string): FormStepResult {
	const field = currentField(session);
	if (!field) {
		return { ok: true, done: true, values: session.values };
	}
	const parsed = parseFieldValue(field, text);
	if (!parsed.ok) {
		return { ok: false, prompt: `${parsed.error}\n${buildFieldPrompt(field)}` };
	}
	session.values[field.id] = parsed.value;
	return advanceFormField(session);
}

export function buildActionModelSession(input: {
	instanceId: string;
	actionId: string;
	actionLabel: string;
	actionPreview?: ActionPreviewLike | null;
	sessionId: string;
	formValues: Record<string, unknown>;
	preview: ProcessActionModelPreviewLike;
	profiles: readonly ModelProfileOptionSummaryLike[];
	now?: number;
	ttlMs?: number;
}): PendingActionModelSession {
	return {
		kind: "action_model",
		instanceId: input.instanceId,
		actionId: input.actionId,
		actionLabel: input.actionLabel,
		actionPreview: input.actionPreview ?? null,
		sessionId: input.sessionId,
		formValues: input.formValues,
		preview: input.preview,
		profiles: input.profiles,
		expiresAt: (input.now ?? Date.now()) + (input.ttlMs ?? 10 * 60 * 1000),
	};
}

export function buildActionModelSwitchWarning(input: {
	session: PendingActionModelSession;
	effectiveModelProfileId: string;
	now?: number;
}): string | null {
	const resolution = resolvePromptCacheSwitch({
		context: input.session.preview.warmPromptCache,
		effectiveModelProfileId: input.effectiveModelProfileId,
		selectableModelProfileIds: input.session.profiles.map((profile) => profile.id),
		now: input.now,
	});
	if (!resolution.switchingModelMayBypassPromptCache) return null;
	const recommendedId = resolution.recommendedModelProfileId;
	if (!recommendedId) {
		return "⚠ Switching models may lose prompt-cache reuse and increase costs. No equivalent selectable profile is currently available.";
	}
	const recommendation =
		input.session.profiles.find((profile) => profile.id === recommendedId)?.label ?? recommendedId;
	return `⚠ Switching models may lose prompt-cache reuse and increase costs. To keep using the previous model, choose ${recommendation}.`;
}

export function buildActionModelPrompt(input: { session: PendingActionModelSession }): string {
	const { session } = input;
	const lines = [`Next-turn model for: ${session.actionLabel}`];
	const preview = session.preview;
	if (preview.description) {
		lines.push(`Target turn: ${preview.description}`);
	}
	const resolved = preview.resolvedModel;
	if (resolved?.status === "resolved" && resolved.modelProfileId) {
		const label =
			session.profiles.find((p) => p.id === resolved.modelProfileId)?.label ??
			resolved.modelProfileId;
		lines.push(`Default/resolved: ${label}`);
	} else if (resolved?.status === "none") {
		lines.push("No model is currently resolved.");
	}
	if (session.profiles.length === 0) {
		lines.push("No model profiles are available.");
	} else {
		lines.push("Choose a model by button, number, or profile id.");
		lines.push("Send /skip to keep the default/resolved model.");
	}
	lines.push("Send /cancel to discard.");
	return lines.join("\n");
}

export type PendingRecoveryModelSession = Extract<
	PendingTelegramSession,
	{ kind: "recovery_model" }
>;

export function buildRecoveryModelSession(input: {
	instanceId: string;
	recoveryKind: "retry" | "continue";
	turnRecordId?: string;
	sessionId: string;
	profiles: readonly ModelProfileOptionSummaryLike[];
	now?: number;
	ttlMs?: number;
}): PendingRecoveryModelSession {
	return {
		kind: "recovery_model",
		instanceId: input.instanceId,
		recoveryKind: input.recoveryKind,
		turnRecordId: input.turnRecordId,
		sessionId: input.sessionId,
		profiles: input.profiles,
		expiresAt: (input.now ?? Date.now()) + (input.ttlMs ?? 10 * 60 * 1000),
	};
}

export function buildRecoveryModelPrompt(input: { session: PendingRecoveryModelSession }): string {
	const { session } = input;
	const label = session.recoveryKind === "retry" ? "Retry" : "Continue";
	const lines = [`Next-turn model for: ${label}`];
	if (session.profiles.length === 0) {
		lines.push("No model profiles are available.");
	} else {
		lines.push("Choose a model by button, number, or profile id.");
		lines.push("Send /skip to keep the current model.");
	}
	lines.push("Send /cancel to discard.");
	return lines.join("\n");
}
