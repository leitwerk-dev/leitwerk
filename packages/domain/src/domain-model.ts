import type { RepoLocatorKind } from "./repo-locator.js";
import type { ProcessSemanticEntryRefKey } from "./semantic-entry-refs.js";
import { trimToNull } from "./string-normalize.js";
import type { FailedTurnRecoveryContext } from "./turn-recovery.js";
import type { ProcessTurnStartTarget } from "./turn-start-resolution.js";

/** @internal */
export type TransitionTrigger =
	| "start"
	| "advance"
	| "revision_requested"
	| "plan_approved"
	| "feedback_received"
	| "operator_re_review"
	| "mr_merged"
	| "abort"
	| "mr_state_waiting";

/** @public */
export type InputSource =
	| "external_comment"
	| "app_steer"
	| "action_prompt"
	| "watcher_event"
	| "llm_review"
	| "system";

/**
 * Stable principal that drove an action, orthogonal to `InputSource` (the
 * channel an input arrived through) and `TransitionTrigger` (the graph edge a
 * transition followed). An `Actor` answers "who acted", not "how" or "why".
 */
/** @public */
export type ActorKind = "user" | "channel" | "system";

/** @public */
export interface Actor {
	/**
	 * Stable principal id, namespaced by provider where applicable.
	 * e.g. "identity-provider:alice", "operator-channel", "system", "admin".
	 */
	/** @public */
	id: string;
	/** @public */
	kind: ActorKind;
	/** Origin that vouched for this actor. `null` for system/admin/local. */
	/** @public */
	provider: string | null;
	/** Optional human-readable name for UI display. */
	/** @internal */
	displayName?: string;
}

/** Watcher / scheduler / startup reconciliation and other internal callers. */
/** @internal */
export const SYSTEM_ACTOR: Actor = { id: "system", kind: "system", provider: null };

/**
 * Unauthenticated default for human-driven web/HTTP/WS actions when no SSO
 * provider is configured. Keeps an auth-disabled leitwerk behaving exactly
 * as it does today while still attributing actions to a stable principal.
 */
/** @internal */
export const ADMIN_ACTOR: Actor = { id: "admin", kind: "user", provider: null };

/** @internal */
export type QuestionSelectionMode = "single" | "multiple";

/** @internal */
export interface NormalizedQuestionOption {
	/** @internal */
	id: string;
	/** @internal */
	label: string;
	/** @internal */
	details: string | null;
}

/** @internal */
export interface NormalizedQuestion {
	/** @internal */
	id: string;
	/** @internal */
	question: string;
	/** @internal */
	selection: QuestionSelectionMode;
	/** @internal */
	options: readonly NormalizedQuestionOption[];
}

/** @internal */
export interface QuestionAnswerDraft {
	/** @internal */
	selectedOptionIds: readonly string[];
	/** @internal */
	freeText: string;
	/** @internal */
	comment: string;
}

/** @internal */
export interface ProcessRelation {
	/** @internal */
	parentInstanceId: string;
	/** @internal */
	childInstanceId: string;
	/** @internal */
	kind: "derived";
	/** @internal */
	purpose: string;
	/** @internal */
	createdAt: string;
	/** @internal */
	createdBy: Actor;
}

/** @internal */
export type ToolApprovalStatus = "open" | "accepted" | "feedback" | "declined" | "cancelled";

/** @internal */
export interface ProcessToolApprovalDestination {
	/** @internal */
	id: string;
	/** @internal */
	displayName: string;
	/** @internal */
	group?: string;
	/** @internal */
	description?: string;
}

/** @internal */
export interface ProcessToolApprovalRequest {
	/** @internal */
	id: string;
	/** @internal */
	instanceId: string;
	/** @internal */
	turnRecordId: string;
	/** @internal */
	toolCallId: string;
	/** @internal */
	toolName: string;
	/** @internal */
	arguments: Record<string, unknown>;
	/** @internal */
	destination: ProcessToolApprovalDestination | null;
	/** @internal */
	status: ToolApprovalStatus;
	/** @internal */
	requestedAt: string;
	/** @internal */
	resolvedAt: string | null;
	/** @internal */
	resolvedBy: Actor | null;
	/** @internal */
	feedback: string | null;
}

/** @internal */
export interface ProcessQuestionRequest {
	/** @internal */
	id: string;
	/** @internal */
	instanceId: string;
	/** @internal */
	turnRecordId: string;
	/** @internal */
	toolCallId: string;
	/** @internal */
	questions: readonly NormalizedQuestion[];
	/** @internal */
	status: "open" | "answered" | "cancelled";
	/** @internal */
	answers: readonly string[] | null;
	/** @internal */
	askedAt: string;
	/** @internal */
	answeredAt: string | null;
	/** @internal */
	answeredBy: Actor | null;
	/** @internal */
	cancelledAt: string | null;
}

function requiredTrimmedString(value: unknown, field: string): string {
	const trimmed = trimToNull(value);
	if (!trimmed) {
		throw new Error(`${field} must be a non-empty string`);
	}
	return trimmed;
}

/** Normalize an LLM-authored request into immutable, position-stable identities. */
/** @internal */
export function normalizeAskQuestionsInput(value: unknown): NormalizedQuestion[] {
	const questions = (
		value as {
			questions?: Array<{
				question?: unknown;
				selection?: unknown;
				options?: Array<{ label?: unknown; details?: unknown }>;
			}>;
		}
	)?.questions;
	if (!Array.isArray(questions)) throw new Error("questions must be an array");
	if (questions.length === 0) throw new Error("questions must not be empty");
	return questions.map((candidate, questionIndex) => {
		const question = requiredTrimmedString(
			candidate?.question,
			`questions[${questionIndex}].question`,
		);
		if (candidate?.selection !== "single" && candidate?.selection !== "multiple") {
			throw new Error(`questions[${questionIndex}].selection must be 'single' or 'multiple'`);
		}
		if (!Array.isArray(candidate.options) || candidate.options.length === 0) {
			throw new Error(`questions[${questionIndex}].options must not be empty`);
		}
		const labels = new Set<string>();
		const questionId = `question_${questionIndex + 1}`;
		const options = candidate.options.map((option, optionIndex) => {
			const label = requiredTrimmedString(
				option?.label,
				`questions[${questionIndex}].options[${optionIndex}].label`,
			);
			const key = label.toLocaleLowerCase();
			if (labels.has(key)) {
				throw new Error(`questions[${questionIndex}] contains duplicate option '${label}'`);
			}
			labels.add(key);
			return {
				id: `${questionId}_option_${optionIndex + 1}`,
				label,
				details: trimToNull(option.details),
			};
		});
		return { id: questionId, question, selection: candidate.selection, options };
	});
}

/** @internal */
export function emptyQuestionDrafts(
	questions: readonly NormalizedQuestion[],
): QuestionAnswerDraft[] {
	return questions.map(() => ({ selectedOptionIds: [], freeText: "", comment: "" }));
}

function normalizeQuestionDrafts(
	questions: readonly NormalizedQuestion[],
	value: unknown,
): QuestionAnswerDraft[] {
	if (!Array.isArray(value) || value.length !== questions.length) {
		throw new Error("Every question must have one draft answer in question order");
	}
	return questions.map((question, index) => {
		const answer = value[index] as Partial<QuestionAnswerDraft> | undefined;
		if (!Array.isArray(answer?.selectedOptionIds)) {
			throw new Error(`Question ${index + 1} has a malformed selection`);
		}
		const selectedOptionIds = answer.selectedOptionIds.map((id) => {
			if (typeof id !== "string" || !question.options.some((option) => option.id === id)) {
				throw new Error(`Question ${index + 1} contains an unknown selection`);
			}
			return id;
		});
		if (new Set(selectedOptionIds).size !== selectedOptionIds.length) {
			throw new Error(`Question ${index + 1} contains duplicate selections`);
		}
		if (question.selection === "single" && selectedOptionIds.length > 1) {
			throw new Error(`Question ${index + 1} accepts only one selection`);
		}
		if (typeof answer.freeText !== "string" || typeof answer.comment !== "string") {
			throw new Error(`Question ${index + 1} contains malformed text`);
		}
		return { selectedOptionIds, freeText: answer.freeText, comment: answer.comment };
	});
}

/** Validate a complete structured draft and produce one canonical free-text answer per question. */
/** @internal */
export function canonicalizeQuestionAnswers(
	questions: readonly NormalizedQuestion[],
	value: unknown,
): string[] {
	return normalizeQuestionDrafts(questions, value).map((answer, index) => {
		const question = questions[index];
		if (!question) throw new Error(`Question ${index + 1} is missing`);
		const options = answer.selectedOptionIds.map(
			(id) => question.options.find((option) => option.id === id)?.label ?? "",
		);
		const freeText = answer.freeText.trim();
		const comment = answer.comment.trim();
		if (options.length === 0 && freeText === "") {
			throw new Error(`Question ${index + 1} requires an answer`);
		}
		return [options.join(", "), freeText, comment ? `Context: ${comment}` : ""]
			.filter(Boolean)
			.join("\n");
	});
}

/**
 * Durable operator/system input queued for worker delivery.
 * `action_prompt` is the conventional source for action-originated follow-up
 * prompts. Delivery semantics are owned by `ProcessInput.target`, not by
 * `source` or `kind`.
 */

/** @public */
export type InputKind = "instruction" | "action" | "system_event";

/** @public */
export type ProcessInputTarget =
	| {
			/** @public */
			semanticRef: ProcessSemanticEntryRefKey;
			/** @internal */
			productName?: never;
	  }
	| {
			/** @internal */
			productName: string;
			/** @public */
			semanticRef?: never;
	  };

/** @internal */
export const WORKER_ERROR_CLASSES = [
	"llm_error",
	"git_error",
	"pi_crash",
	"pipeline_error",
	"infrastructure",
	"protocol_error",
	"operator_abort",
] as const;

/** @internal */
export type WorkerErrorClass = (typeof WORKER_ERROR_CLASSES)[number];

/** @internal */
export function isWorkerErrorClass(value: string): value is WorkerErrorClass {
	return (WORKER_ERROR_CLASSES as readonly string[]).includes(value);
}

/** @internal */
export type TurnFailureCode = "branch_drift";

/** @internal */
export function isTurnFailureCode(value: string): value is TurnFailureCode {
	return value === "branch_drift";
}

/** Extension-defined stable turn identifier. */
/** @public */
export type TurnId = string;

/** @internal */
export const PROCESS_TURN_TYPES = ["llm", "human", "external", "automatic"] as const;

/** @internal */
export type ProcessTurnType = (typeof PROCESS_TURN_TYPES)[number];

/** @internal */
export interface TurnOutcomePayload {
	/** @internal */
	resultSummary?: string;
	/** @internal */
	instanceId: string;
	/** @internal */
	turnRecordId: string;
	/** @internal */
	turnId: TurnId;
	/** @internal */
	turnType: ProcessTurnType;
	/** @internal */
	outcome: string;
	/** @internal */
	params: Record<string, unknown>;
	/** @internal */
	pathType?: ProcessTurnRecordPathType;
	/** @internal */
	forkPiEntryId?: string | null;
	/** @internal */
	resultPiEntryId?: string | null;
	/** @internal */
	turnResultMarkdown?: string | null;
	/** @internal */
	rootEntryId?: string | null;
	/** @internal */
	state?: unknown;
}

/** @internal */
export interface TurnFailedPayload {
	/** @internal */
	instanceId: string;
	/** @internal */
	turnRecordId: string;
	/** @internal */
	turnId: TurnId;
	/** @internal */
	turnType: ProcessTurnType;
	/** @internal */
	pathType: ProcessTurnRecordPathType;
	/** @internal */
	forkPiEntryId?: string | null;
	/** @internal */
	resultPiEntryId?: string | null;
	/** @internal */
	errorSummary: string;
	/** @internal */
	errorClass?: WorkerErrorClass;
	/** @internal */
	failureCode?: TurnFailureCode | null;
	/** @internal */
	failureDetails?: Record<string, unknown> | null;
	/** @internal */
	recoveryContext?: FailedTurnRecoveryContext | null;
}

/** @public */
export type ProcessLifecycleStatus =
	| "discovered"
	| "active"
	| "waiting"
	| "error"
	| "completed"
	| "aborted";

/** @internal */
export function isProcessTurnType(value: unknown): value is ProcessTurnType {
	return typeof value === "string" && (PROCESS_TURN_TYPES as readonly string[]).includes(value);
}

/** @internal */
export function isWorkerOwnedTurnType(turnType: ProcessTurnType): boolean {
	return turnType === "llm" || turnType === "automatic";
}

/** @internal */
export function isWaitingTurnType(turnType: ProcessTurnType): boolean {
	return turnType === "human" || turnType === "external";
}

/** @internal */
export function lifecycleStatusForSelectedTurnType(
	turnType: ProcessTurnType,
): Extract<ProcessLifecycleStatus, "active" | "waiting"> {
	return isWaitingTurnType(turnType) ? "waiting" : "active";
}

/** @internal */
export type ProcessSelectedTurnModelSource =
	| "action_override"
	| "launch_override"
	| "instance_turn_config"
	| "process_config_turn"
	| "instance_default"
	| "process_config_default"
	| "catalog_default"
	| "legacy_persisted";

/** @internal */
export type ModelSelectionKind = "explicit" | "inherited";
/** @internal */
export type ModelSelectionSource = ProcessSelectedTurnModelSource;

/** Durable intent and resolution path for one effective model selection. */
/** @internal */
export interface ModelSelectionProvenance {
	/** @internal */
	kind: ModelSelectionKind;
	/** @internal */
	source: ModelSelectionSource;
}

/** @internal */
export interface DurableModelSelection {
	/** @internal */
	modelProfileId: string;
	/** @internal */
	provenance: ModelSelectionProvenance;
}

/** @internal */
export type ModelPolicyFailureCode =
	| "invalid_model_configuration"
	| "unknown_model_profile"
	| "model_profile_not_allowed"
	| "model_required"
	| "model_unavailable"
	| "model_stale"
	| "stale_evaluation_snapshot";

/** @internal */
export interface FutureExecutionBlockReason {
	/** @internal */
	code: ModelPolicyFailureCode;
	/** @internal */
	selection: DurableModelSelection | null;
	/** @internal */
	summary: string;
	/** @internal */
	detectedAt: string;
	/** Present when the block depends on a runtime availability snapshot. */
	/** @internal */
	availabilityRevision?: number;
}

/** JSON object persisted as non-secret turn-start configuration. */
/** @internal */
export type JsonObject = Record<string, unknown>;

/** The one durable technical execution currently owned by a process. */
/** @internal */
export type CurrentExecutionRef = {
	/** @internal */
	kind: "worker_start";
	/** @internal */
	id: string;
} | null;

/** Immutable non-secret inputs resolved for a worker-owned turn start. */
/** @internal */
export type ResolvedTurnStart =
	| {
			/** @internal */
			kind: "llm";
			/** @internal */
			model: {
				/** @internal */
				profileId: string;
				/** @internal */
				providerId: string;
				/** @internal */
				modelId: string;
				/** @internal */
				thinkingLevel: string;
			};
			/** Frozen provenance used to resolve this prepared start. */
			/** @internal */
			modelSelectionProvenance?: ModelSelectionProvenance;
			/** Status revision evaluated before preparation. Diagnostic only. */
			/** @internal */
			availabilityRevision?: number;
			/** @internal */
			providerOptions: Record<string, string>;
			/** @internal */
			providerWorkerConfig: {
				/** @internal */
				version: number;
				/** @internal */
				value: JsonObject;
			} | null;
			/** @internal */
			piResourceSnapshotDigest: string;
			/** @internal */
			workerRuntimeProfileId: string;
			/** @internal */
			piSettings: JsonObject;
	  }
	| {
			/** @internal */
			kind: "automatic";
	  };

/** @internal */
export type TurnStartKind = "selected_turn" | "retry" | "continue" | "startup_retry";

/** @internal */
export interface TurnStartContinuation {
	/** @internal */
	continueFromPiEntryId: string;
	/** @internal */
	continuePrompt: string;
	/** @internal */
	savedPrimaryLeafEntryId: string | null;
}

/** @internal */
export type TurnStartPreparationFailureCode =
	| "invalid_model_configuration"
	| "model_required"
	| "model_unavailable"
	| "model_stale"
	| "provider_options_required"
	| "provider_preflight_failed";

/** @internal */
export type TurnStartRecordState =
	| {
			/** @internal */
			kind: "preparation_failed";
			/** @internal */
			requestedModelProfileId: string | null;
			/** @internal */
			providerOptions: Record<string, string>;
			/** @internal */
			code: TurnStartPreparationFailureCode;
			/** @internal */
			safeSummary: string;
			/** @internal */
			modelSelectionProvenance?: ModelSelectionProvenance;
			/** @internal */
			availabilityRevision?: number;
	  }
	| {
			/** @internal */
			kind: "starting";
			/** @internal */
			start: ResolvedTurnStart;
	  }
	| {
			/** @internal */
			kind: "bootstrap_failed";
			/** @internal */
			start: ResolvedTurnStart;
			/** @internal */
			failedWorkerLeaseId: string | null;
			/** @internal */
			code: string;
			/** @internal */
			safeSummary: string;
	  }
	| {
			/** @internal */
			kind: "accepted";
			/** @internal */
			start: ResolvedTurnStart;
			/** @internal */
			turnRecordId: string;
			/** @internal */
			acceptedWorkerLeaseId: string;
	  }
	| {
			/** @internal */
			kind: "superseded";
			/** @internal */
			start: ResolvedTurnStart | null;
	  };

/** Durable preparation for a single worker-owned selected turn, not an attempt. */
/** @internal */
export interface TurnStartRecord {
	/** @internal */
	id: string;
	/** @internal */
	instanceId: string;
	/** @internal */
	turnId: TurnId;
	/** @internal */
	turnType: Extract<ProcessTurnType, "llm" | "automatic">;
	/** Reserved id used when, and only when, this start is accepted. */
	/** @internal */
	proposedTurnRecordId: string;
	/** @internal */
	startKind: TurnStartKind;
	/** @internal */
	recoveryTurnRecordId: string | null;
	/** @internal */
	continuation: TurnStartContinuation | null;
	/** @internal */
	state: TurnStartRecordState;
	/** @internal */
	createdAt: string;
	/** @internal */
	updatedAt: string;
}

/** Tree positioning selected during bootstrap, before a turn is accepted. */
/** @internal */
export interface PreparedTurnStart {
	/** @internal */
	pathType: ProcessTurnRecordPathType;
	/** Durable authored context mode used to reconcile pre-prompt positioning and compaction. */
	/** @internal */
	contextMode: LlmContextMode;
	/** @internal */
	startTarget: ProcessTurnStartTarget;
	/** @internal */
	forkPiEntryId: string | null;
}

/** @internal */
export type LlmContextMode = "full" | "compacted" | "fresh" | "fresh_seeded";

/** Immutable, lease-correlated proof of successful worker bootstrap. */
/** @internal */
export type WorkerBootstrapReceipt =
	| {
			/** @internal */
			kind: "llm";
			/** @internal */
			startRecordId: string;
			/** @internal */
			workerLeaseId: string;
			/** @internal */
			receiptEpoch: string;
			/** @internal */
			verifiedResourceSnapshotDigest: string;
			/** @internal */
			credentialRevision: number | null;
			/** @internal */
			loadedResourceIds: string[];
			/** @internal */
			resolvedModel: {
				/** @internal */
				providerId: string;
				/** @internal */
				modelId: string;
			};
			/** @internal */
			preparedStart: PreparedTurnStart | null;
			/** @internal */
			readyAt: string;
	  }
	| {
			/** @internal */
			kind: "automatic";
			/** @internal */
			startRecordId: string;
			/** @internal */
			workerLeaseId: string;
			/** @internal */
			receiptEpoch: string;
			/** @internal */
			readyAt: string;
	  };

/** @internal */
export const PROCESS_SELECTED_TURN_MODEL_SOURCES = [
	"action_override",
	"launch_override",
	"instance_turn_config",
	"process_config_turn",
	"instance_default",
	"process_config_default",
	"catalog_default",
	"legacy_persisted",
] as const satisfies readonly ProcessSelectedTurnModelSource[];

/** @internal */
export function isProcessSelectedTurnModelSource(
	value: unknown,
): value is ProcessSelectedTurnModelSource {
	return PROCESS_SELECTED_TURN_MODEL_SOURCES.includes(value as ProcessSelectedTurnModelSource);
}

/** @public */
export interface ProcessCustomizableFields {
	/** @internal */
	title?: string | null;
	/** @public */
	externalId?: string | null;
	/** @internal */
	externalUrl?: string | null;
	/** @internal */
	metadata?: Record<string, unknown> | null;
	/** @internal */
	defaultModelProfileId?: string | null;
	/** @internal */
	initialDefaultModelProfileId?: string | null;
	/** @internal */
	turnConfigsJson?: string | null;
	/** @internal */
	selectedTurnModelProfileId?: string | null;
	/** @internal */
	selectedTurnModelKind?: ModelSelectionKind | null;
	/** @internal */
	selectedTurnModelSource?: ProcessSelectedTurnModelSource | null;
}

/** @public */
export interface ProcessInstance {
	/** @public */
	id: string;
	/** Canonical process identifier from the extension catalog. */
	/** @public */
	processId: string;
	/** Durable pointer to the currently selected business turn, if any. */
	/** @public */
	selectedTurnId: TurnId | null;
	/** High-level lifecycle bucket for scheduling and operator state. */
	/** @public */
	lifecycleStatus: ProcessLifecycleStatus;
	/** Single durable technical execution reference; null for waiting/terminal states. */
	/** @internal */
	currentExecution: CurrentExecutionRef;
	/** @public */
	planRevision: number;
	/** Short operator-facing process title used in process lists and related UI. */
	/** @public */
	title: string | null;
	/** Provider-agnostic external reference, such as a work item key or change path. */
	/** @public */
	externalId: string | null;
	/** URL to the external resource, if applicable. */
	/** @internal */
	externalUrl: string | null;
	/** Extension-owned JSON metadata blob. */
	/** @internal */
	metadata: Record<string, unknown> | null;
	/** Instance-scoped default model profile used when no turn override applies. */
	/** @internal */
	defaultModelProfileId?: string | null;
	/** Effective default model at creation time, retained for historical inspection. */
	/** @internal */
	initialDefaultModelProfileId?: string | null;
	/** JSON-serialized per-turn runtime config overrides for this instance. */
	/** @internal */
	turnConfigsJson?: string | null;
	/** Frozen effective model profile for the currently selected LLM turn, if any. */
	/** @internal */
	selectedTurnModelProfileId?: string | null;
	/** Explicit operator intent or inherited policy resolution for the selected model. */
	/** @internal */
	selectedTurnModelKind?: ModelSelectionKind | null;
	/** Resolution path that selected `selectedTurnModelProfileId`; null for empty selections. */
	/** @internal */
	selectedTurnModelSource?: ProcessSelectedTurnModelSource | null;
	/** JSON-serialized process params. */
	/** @public */
	paramsJson: string | null;
	/** JSON-serialized process state. */
	/** @public */
	stateJson: string | null;
	/** @public */
	createdAt: string;
	/** @internal */
	updatedAt: string;
	/** Set once when the process first reaches a terminal lifecycle status. */
	/** @internal */
	closedAt?: string | null;
}

/** @public */
export interface ProcessProject {
	/** @public */
	id: string;
	/** @public */
	instanceId: string;
	/** @public */
	key: string;
	/** Repository source identifier. May be a remote URL or a local filesystem path. */
	/** @public */
	repoLocator: string;
	/** @internal */
	repoLocatorKind: RepoLocatorKind;
	/** @internal */
	baseBranch: string;
	/** @internal */
	workBranch: string | null;
	/** Provider-agnostic external identifier (e.g. MR IID, PR number). */
	/** @internal */
	externalId: string | null;
	/** URL to the external resource (e.g. MR URL, PR URL). */
	/** @internal */
	externalUrl: string | null;
	/** Extension-owned JSON metadata blob. */
	/** @public */
	metadata: Record<string, unknown> | null;
	/** @internal */
	pipelineStatus: string | null;
	/** @internal */
	createdAt: string;
	/** @internal */
	updatedAt: string;
}

/** @internal */
export interface ProcessInput {
	/** @internal */
	id: string;
	/** @internal */
	instanceId: string;
	/** @internal */
	sequence: number;
	/** @internal */
	source: InputSource;
	/** @internal */
	kind: InputKind;
	/** @internal */
	target: ProcessInputTarget | null;
	/** @internal */
	bodyMarkdown: string;
	/** Stable principal that queued this input. Defaults to `SYSTEM_ACTOR`. */
	/** @internal */
	actor: Actor;
	/** @internal */
	receivedAt: string;
	/** @internal */
	consumedAt: string | null;
}

/** @internal */
export type LaunchOrigin = "ui" | "programmatic" | "watcher" | "scheduled" | "startup_retry";
/** @internal */
export type LaunchRunStatus =
	| "preparing"
	| "process_created"
	| "starting"
	| "completed"
	| "failed"
	| "cancelled";
/** @internal */
export type LaunchChecklistStepStatus =
	| "pending"
	| "in_progress"
	| "completed"
	| "failed"
	| "skipped";

/** Presentation-safe durable progress for one process launch attempt. */
/** @internal */
export interface LaunchChecklistStep {
	/** @internal */
	id: string;
	/** @internal */
	label: string;
	/** @internal */
	status: LaunchChecklistStepStatus;
	/** @internal */
	safeSummary?: string;
	/** @internal */
	startedAt?: string;
	/** @internal */
	completedAt?: string;
}

/** Durable launch attempt. Secrets and runner identifiers never belong here. */
/** @internal */
export interface LaunchRun {
	/** @internal */
	id: string;
	/** @internal */
	launcherId: string | null;
	/** @internal */
	origin: LaunchOrigin;
	/** @internal */
	instanceId: string | null;
	/** @internal */
	status: LaunchRunStatus;
	/** @internal */
	steps: LaunchChecklistStep[];
	/** @internal */
	createdAt: string;
	/** @internal */
	updatedAt: string;
	/** @internal */
	completedAt: string | null;
	/** @internal */
	revision: number;
}

/** @internal */
export type FutureExecutionKind = "launch" | "action";
/** @internal */
export type FutureExecutionScheduleKind = "once" | "cron";

/** @internal */
export interface FutureExecution {
	/** @internal */
	id: string;
	/** @internal */
	kind: FutureExecutionKind;
	/** @internal */
	scheduleKind: FutureExecutionScheduleKind;
	/** Canonical target process identifier. */
	/** @internal */
	processId: string;
	/** Populated only for scheduled actions on an existing process instance. */
	/** @internal */
	instanceId: string | null;
	/** @internal */
	launcherId: string | null;
	/** @internal */
	actionId: string | null;
	/** JSON-serialized kind-specific payload. */
	/** @internal */
	payloadJson: string;
	/** @internal */
	cronExpression: string | null;
	/** @internal */
	nextRunAt: string;
	/** Immediate LLM selection caused by this execution, if known. */
	/** @internal */
	modelSelection?: DurableModelSelection | null;
	/** Structured model-policy block. Blocked rows remain durable. */
	/** @internal */
	blockedReason?: FutureExecutionBlockReason | null;
	/** @internal */
	createdAt: string;
	/** @internal */
	updatedAt: string;
}

/** @internal */
export interface ProcessEvent {
	/** Persisted ingestion order. Absent only on legacy in-memory fixtures. */
	/** @internal */
	eventSequence?: number;
	/** @internal */
	id: string;
	/** @internal */
	instanceId: string;
	/** @internal */
	eventType: string;
	/** @internal */
	data: Record<string, unknown>;
	/** @internal */
	createdAt: string;
}

/** @internal */
export type ProcessLeafOutcomeSnapshotStatus = "ready" | "capture_error";

/** @internal */
export interface ProcessLeafOutcomeSnapshot {
	/** @internal */
	id: string;
	/** @internal */
	instanceId: string;
	/** @internal */
	leafEntryId: string;
	/** @internal */
	turnRecordId: string | null;
	/** @internal */
	rendererId: string | null;
	/** @internal */
	schemaVersion: number | null;
	/** @internal */
	props: Record<string, unknown> | null;
	/** @internal */
	fallbackMarkdown: string | null;
	/** @internal */
	status: ProcessLeafOutcomeSnapshotStatus;
	/** @internal */
	warningCode: string | null;
	/** @internal */
	warningMessage: string | null;
	/** @internal */
	anchoredAt: string;
	/** @internal */
	createdAt: string;
}

/** @public */
export type ProcessTurnRecordStatus = "running" | "succeeded" | "failed" | "superseded";

/** @public */
export type TurnProgressStepStatus = "incomplete" | "in_progress" | "completed" | "failed";

/** @public */
export interface TurnProgressStep {
	/** @public */
	id: string;
	/** @public */
	label: string;
	/** @public */
	status: TurnProgressStepStatus;
	/** @public */
	detail?: string | null;
}

/** @public */
export interface TurnProgressLink {
	/** @public */
	id: string;
	/** @public */
	label: string;
	/** @public */
	url: string;
	/** @public */
	kind?: "pull_request" | "merge_request" | "commit" | "pipeline" | "other";
}

/** A complete operator-facing snapshot. Reporters replace, rather than patch, this value. */
/** @public */
export interface TurnProgressReport {
	/** @public */
	title: string;
	/** Attempt-specific progress or waiting explanation; not an operation receipt. */
	/** @public */
	summary?: string;
	/** @public */
	steps: TurnProgressStep[];
	/** @public */
	links?: TurnProgressLink[];
}

/**
 * Structural tree position for a turn record.
 * - `primary`: continue the primary path from the current leaf
 * - `root_branch`: start from the implicit session root with no prior Pi entry context
 * - `leaf_branch`: fork from the current leaf as a side path
 */
/** @public */
export const PROCESS_TURN_RECORD_PATH_TYPES = ["primary", "root_branch", "leaf_branch"] as const;

/** @public */
export type ProcessTurnRecordPathType = (typeof PROCESS_TURN_RECORD_PATH_TYPES)[number];

/** @public */
export interface ProcessTurnRecord {
	/** @public */
	id: string;
	/** @internal */
	instanceId: string;
	/** @public */
	turnId: TurnId;
	/** @internal */
	turnType: ProcessTurnType;
	/** @public */
	status: ProcessTurnRecordStatus;
	/** @internal */
	attemptNumber: number;
	/** @internal */
	parentTurnRecordId: string | null;
	/** @internal */
	pathType: ProcessTurnRecordPathType;
	/** @internal */
	forkPiEntryId: string | null;
	/** Accepted worker-start preparation that created this worker-owned record. */
	/** @internal */
	turnStartRecordId?: string | null;
	/** Lease whose receipt first authorized this worker-owned record. */
	/** @internal */
	acceptedWorkerLeaseId?: string | null;
	/** @internal */
	resultPiEntryId: string | null;
	/** @internal */
	modelProfileId: string | null;
	/** @internal */
	modelSelectionProvenance?: ModelSelectionProvenance | null;
	/** @internal */
	turnResultMarkdown: string | null;
	/** @public */
	errorSummary: string | null;
	/** @internal */
	errorClass: WorkerErrorClass | null;
	/** @internal */
	startedAt: string;
	/** @internal */
	endedAt: string | null;
}

/** @internal */
export interface WorkerLease {
	/** @internal */
	id: string;
	/** @internal */
	instanceId: string;
	/** @internal */
	workerId: string;
	/** Worker start this physical lease was created to execute. */
	/** @internal */
	turnStartRecordId?: string | null;
	/** Durable server-owned supervision state for the current worker lease. */
	/** @internal */
	state: WorkerState;
	/** Server epoch this lease belongs to, used to reject stale snapshot writes. */
	/** @internal */
	serverEpoch?: string | null;
	/** Hash of the lease-scoped WebSocket connect token. The raw token is never stored. */
	/** @internal */
	connectTokenHash?: string | null;
	/** Hash of the lease-scoped HTTP session-snapshot credential. The raw token is never stored. */
	/** @internal */
	snapshotTokenHash?: string | null;
	/** Fingerprint of the effective instance model policy/config snapshot used to start this worker. */
	/** @internal */
	modelPolicyFingerprint?: string | null;
	/** First valid lease-correlated bootstrap receipt; written once by the server. */
	/** @internal */
	bootstrapReceipt?: WorkerBootstrapReceipt | null;
	/** Updated from heartbeats for liveness/recovery diagnostics. */
	/** @internal */
	lastHeartbeatAt: string | null;
	/** @internal */
	startedAt: string;
	/** First valid server-observed worker handshake. */
	/** @internal */
	connectedAt?: string | null;
	/** First valid server-observed workspace preparation progress. */
	/** @internal */
	workspacePreparationStartedAt?: string | null;
	/** First accepted server-observed worker readiness. */
	/** @internal */
	readyAt?: string | null;
	/** Set once the lease is no longer active for supervision. */
	/** @internal */
	exitedAt: string | null;
}

/**
 * Durable worker lease states owned by the server.
 * `absent` is conceptual in lifecycle logic and usually represented by
 * the absence of an active lease row.
 */
/** @internal */
export type WorkerState =
	| "absent"
	| "spawning"
	| "bootstrapping"
	| "idle"
	| "busy"
	| "draining"
	| "failed"
	| "cleanup"
	| "exited";

/**
 * External write type identifier. Extensions define their own write types
 * as plain strings (e.g. "tracker.approved_plan_comment", "code_host.create_change").
 */
/** @public */
export type ExternalWriteType = string;

/** @public */
export interface ExternalWriteLog {
	/** @internal */
	id: string;
	/** @internal */
	instanceId: string;
	/** @public */
	writeType: ExternalWriteType;
	/** @internal */
	dedupKey: string;
	/** @internal */
	completedAt: string;
	/** @internal */
	metadata: Record<string, unknown>;
}

/**
 * Returns a human-readable, operator-facing label for the structural path
 * position of a turn record. These labels avoid internal domain terms such
 * as "primary" or "root_branch" in favour of plain descriptions of what the
 * turn is doing relative to the main path.
 */
/** @internal */
export function formatPathTypeLabel(pathType: ProcessTurnRecordPathType): string {
	switch (pathType) {
		case "primary":
			return "Continuing the main path";
		case "root_branch":
			return "Starting from the beginning";
		case "leaf_branch":
			return "Exploring an alternative";
		default:
			return "Path";
	}
}
