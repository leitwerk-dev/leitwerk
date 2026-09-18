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

/** @internal */
export interface ActionPreviewLike {
	/** @internal */
	kind?: string;
	/** @internal */
	turnId?: string;
	/** @internal */
	lifecycleStatus?: string;
}

/** @internal */
interface PendingAction {
	/** @internal */
	actionId: string;
	/** @internal */
	actionLabel: string;
	/** @internal */
	actionPreview?: ActionPreviewLike | null;
	/** @internal */
	sessionId: string;
}

/** @internal */
export type PendingTelegramSession = {
	/** @internal */
	instanceId: string;
	/** @internal */
	expiresAt: number;
} & (
	| (PendingAction & {
			/** @internal */
			kind: "action_form";
			/** @internal */
			form: FormDefinition;
			/** @internal */
			fieldIndex: number;
			/** @internal */
			values: Record<string, unknown>;
	  })
	| (PendingAction & {
			/** @internal */
			kind: "action_model";
			/** @internal */
			formValues: Record<string, unknown>;
			/** @internal */
			preview: ProcessActionModelPreviewLike;
			/** @internal */
			profiles: readonly ModelProfileOptionSummaryLike[];
	  })
	| {
			/** @internal */
			kind: "recovery_model";
			/** @internal */
			recoveryKind: "retry" | "continue";
			/** @internal */
			turnRecordId?: string;
			/** @internal */
			sessionId: string;
			/** @internal */
			profiles: readonly ModelProfileOptionSummaryLike[];
			/** @internal */
			selectedModelProfileId?: string | null;
	  }
	| {
			/** @internal */
			kind: "continue";
			/** @internal */
			turnRecordId: string;
			/** @internal */
			nextTurnModelProfileId?: string | null;
	  }
	| {
			/** @internal */
			kind: "question";
			/** @internal */
			request: ProcessQuestionRequest;
			/** @internal */
			questionIndex: number;
			/** @internal */
			draft: QuestionAnswerDraft[];
	  }
);

/** @internal */
export type PendingActionFormSession = Extract<PendingTelegramSession, { kind: "action_form" }>;
/** @internal */
export type PendingActionModelSession = Extract<PendingTelegramSession, { kind: "action_model" }>;
/** @internal */
export type PendingQuestionSession = Extract<PendingTelegramSession, { kind: "question" }>;

/** @internal */
export type FormStepResult =
	| {
			/** @internal */
			ok: true;
			/** @internal */
			done: false;
			/** @internal */
			prompt: string;
	  }
	| {
			/** @internal */
			ok: true;
			/** @internal */
			done: true;
			/** @internal */
			values: Record<string, unknown>;
	  }
	| {
			/** @internal */
			ok: false;
			/** @internal */
			prompt: string;
	  };

/** @internal */
export function buildActionFormSession(input: {
	/** @internal */
	instanceId: string;
	/** @internal */
	actionId: string;
	/** @internal */
	actionLabel?: string;
	/** @internal */
	actionPreview?: ActionPreviewLike | null;
	/** @internal */
	sessionId: string;
	/** @internal */
	form: FormDefinition;
	/** @internal */
	now?: number;
	/** @internal */
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

/** @internal */
export function buildQuestionSession(input: {
	/** @internal */
	instanceId: string;
	/** @internal */
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

/** @internal */
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

/** @internal */
export function applyQuestionText(
	session: PendingQuestionSession,
	text: string,
): {
	/** @internal */
	done: boolean;
	/** @internal */
	draft: QuestionAnswerDraft[];
	/** @internal */
	prompt?: string;
} {
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

/** @internal */
export function buildContinueSession(input: {
	/** @internal */
	instanceId: string;
	/** @internal */
	turnRecordId: string;
	/** @internal */
	nextTurnModelProfileId?: string | null;
	/** @internal */
	now?: number;
	/** @internal */
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

/** @internal */
export function currentField(session: PendingActionFormSession): FormFieldDefinition | null {
	return session.form.fields[session.fieldIndex] ?? null;
}

/** @internal */
export function buildFieldPrompt(field: FormFieldDefinition): string {
	const required = field.required ? " required" : "";
	const description = field.description ? `\n${field.description}` : "";
	const hint = field.placeholder ? `\nHint: ${field.placeholder}` : "";
	return `Enter ${field.label}${required}.${description}${hint}`;
}

/** @internal */
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

/** @internal */
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

/** @internal */
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

/** @internal */
export function buildActionModelSession(input: {
	/** @internal */
	instanceId: string;
	/** @internal */
	actionId: string;
	/** @internal */
	actionLabel: string;
	/** @internal */
	actionPreview?: ActionPreviewLike | null;
	/** @internal */
	sessionId: string;
	/** @internal */
	formValues: Record<string, unknown>;
	/** @internal */
	preview: ProcessActionModelPreviewLike;
	/** @internal */
	profiles: readonly ModelProfileOptionSummaryLike[];
	/** @internal */
	now?: number;
	/** @internal */
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

/** @internal */
export function buildActionModelSwitchWarning(input: {
	/** @internal */
	session: PendingActionModelSession;
	/** @internal */
	effectiveModelProfileId: string;
	/** @internal */
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

/** @internal */
export function buildActionModelPrompt(input: {
	/** @internal */
	session: PendingActionModelSession;
}): string {
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

/** @internal */
export type PendingRecoveryModelSession = Extract<
	PendingTelegramSession,
	{ kind: "recovery_model" }
>;

/** @internal */
export function buildRecoveryModelSession(input: {
	/** @internal */
	instanceId: string;
	/** @internal */
	recoveryKind: "retry" | "continue";
	/** @internal */
	turnRecordId?: string;
	/** @internal */
	sessionId: string;
	/** @internal */
	profiles: readonly ModelProfileOptionSummaryLike[];
	/** @internal */
	now?: number;
	/** @internal */
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

/** @internal */
export function buildRecoveryModelPrompt(input: {
	/** @internal */
	session: PendingRecoveryModelSession;
}): string {
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
