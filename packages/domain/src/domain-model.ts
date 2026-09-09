import type { RepoLocatorKind } from "./repo-locator.js";
import type { ProcessSemanticEntryRefKey } from "./semantic-entry-refs.js";
import { trimToNull } from "./string-normalize.js";
import type { FailedTurnRecoveryContext } from "./turn-recovery.js";
import type { ProcessTurnStartTarget } from "./turn-start-resolution.js";

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
export type ActorKind = "user" | "channel" | "system";

export interface Actor {
	/**
	 * Stable principal id, namespaced by provider where applicable.
	 * e.g. "identity-provider:alice", "operator-channel", "system", "admin".
	 */
	id: string;
	kind: ActorKind;
	/** Origin that vouched for this actor. `null` for system/admin/local. */
	provider: string | null;
	/** Optional human-readable name for UI display. */
	displayName?: string;
}

/** Watcher / scheduler / startup reconciliation and other internal callers. */
export const SYSTEM_ACTOR: Actor = { id: "system", kind: "system", provider: null };

/**
 * Unauthenticated default for human-driven web/HTTP/WS actions when no SSO
 * provider is configured. Keeps an auth-disabled leitwerk behaving exactly
 * as it does today while still attributing actions to a stable principal.
 */
export const ADMIN_ACTOR: Actor = { id: "admin", kind: "user", provider: null };

export type QuestionSelectionMode = "single" | "multiple";

export interface NormalizedQuestionOption {
	id: string;
	label: string;
	details: string | null;
}

export interface NormalizedQuestion {
	id: string;
	question: string;
	selection: QuestionSelectionMode;
	options: readonly NormalizedQuestionOption[];
}

export interface QuestionAnswerDraft {
	selectedOptionIds: readonly string[];
	freeText: string;
	comment: string;
}

export interface ProcessRelation {
	parentInstanceId: string;
	childInstanceId: string;
	kind: "derived";
	purpose: string;
	createdAt: string;
	createdBy: Actor;
}

export type ToolApprovalStatus = "open" | "accepted" | "feedback" | "declined" | "cancelled";

export interface ProcessToolApprovalDestination {
	id: string;
	displayName: string;
	group?: string;
	description?: string;
}

export interface ProcessToolApprovalRequest {
	id: string;
	instanceId: string;
	turnRecordId: string;
	toolCallId: string;
	toolName: string;
	arguments: Record<string, unknown>;
	destination: ProcessToolApprovalDestination | null;
	status: ToolApprovalStatus;
	requestedAt: string;
	resolvedAt: string | null;
	resolvedBy: Actor | null;
	feedback: string | null;
}

export interface ProcessQuestionRequest {
	id: string;
	instanceId: string;
	turnRecordId: string;
	toolCallId: string;
	questions: readonly NormalizedQuestion[];
	status: "open" | "answered" | "cancelled";
	answers: readonly string[] | null;
	askedAt: string;
	answeredAt: string | null;
	answeredBy: Actor | null;
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

export type InputKind = "instruction" | "action" | "system_event";

export type ProcessInputTarget =
	| { semanticRef: ProcessSemanticEntryRefKey; productName?: never }
	| { productName: string; semanticRef?: never };

export const WORKER_ERROR_CLASSES = [
	"llm_error",
	"git_error",
	"pi_crash",
	"pipeline_error",
	"infrastructure",
	"protocol_error",
	"operator_abort",
] as const;

export type WorkerErrorClass = (typeof WORKER_ERROR_CLASSES)[number];

export function isWorkerErrorClass(value: string): value is WorkerErrorClass {
	return (WORKER_ERROR_CLASSES as readonly string[]).includes(value);
}

export type TurnFailureCode = "branch_drift";

export function isTurnFailureCode(value: string): value is TurnFailureCode {
	return value === "branch_drift";
}

/** Extension-defined stable turn identifier. */
export type TurnId = string;

export const PROCESS_TURN_TYPES = ["llm", "human", "external", "automatic"] as const;

export type ProcessTurnType = (typeof PROCESS_TURN_TYPES)[number];

export interface TurnOutcomePayload {
	instanceId: string;
	turnRecordId: string;
	turnId: TurnId;
	turnType: ProcessTurnType;
	outcome: string;
	params: Record<string, unknown>;
	pathType?: ProcessTurnRecordPathType;
	forkPiEntryId?: string | null;
	resultPiEntryId?: string | null;
	turnResultMarkdown?: string | null;
	rootEntryId?: string | null;
	state?: unknown;
}

export interface TurnFailedPayload {
	instanceId: string;
	turnRecordId: string;
	turnId: TurnId;
	turnType: ProcessTurnType;
	pathType: ProcessTurnRecordPathType;
	forkPiEntryId?: string | null;
	resultPiEntryId?: string | null;
	errorSummary: string;
	errorClass?: WorkerErrorClass;
	failureCode?: TurnFailureCode | null;
	failureDetails?: Record<string, unknown> | null;
	recoveryContext?: FailedTurnRecoveryContext | null;
}

export type ProcessLifecycleStatus =
	| "discovered"
	| "active"
	| "waiting"
	| "error"
	| "completed"
	| "aborted";

export function isProcessTurnType(value: unknown): value is ProcessTurnType {
	return typeof value === "string" && (PROCESS_TURN_TYPES as readonly string[]).includes(value);
}

export function isWorkerOwnedTurnType(turnType: ProcessTurnType): boolean {
	return turnType === "llm" || turnType === "automatic";
}

export function isWaitingTurnType(turnType: ProcessTurnType): boolean {
	return turnType === "human" || turnType === "external";
}

export function lifecycleStatusForSelectedTurnType(
	turnType: ProcessTurnType,
): Extract<ProcessLifecycleStatus, "active" | "waiting"> {
	return isWaitingTurnType(turnType) ? "waiting" : "active";
}

export type ProcessSelectedTurnModelSource =
	| "action_override"
	| "launch_override"
	| "instance_turn_config"
	| "process_config_turn"
	| "instance_default"
	| "process_config_default"
	| "catalog_default"
	| "legacy_persisted";

export type ModelSelectionKind = "explicit" | "inherited";
export type ModelSelectionSource = ProcessSelectedTurnModelSource;

/** Durable intent and resolution path for one effective model selection. */
export interface ModelSelectionProvenance {
	kind: ModelSelectionKind;
	source: ModelSelectionSource;
}

export interface DurableModelSelection {
	modelProfileId: string;
	provenance: ModelSelectionProvenance;
}

export type ModelPolicyFailureCode =
	| "invalid_model_configuration"
	| "unknown_model_profile"
	| "model_profile_not_allowed"
	| "model_required"
	| "model_unavailable"
	| "model_stale"
	| "stale_evaluation_snapshot";

export interface FutureExecutionBlockReason {
	code: ModelPolicyFailureCode;
	selection: DurableModelSelection | null;
	summary: string;
	detectedAt: string;
	/** Present when the block depends on a runtime availability snapshot. */
	availabilityRevision?: number;
}

/** JSON object persisted as non-secret turn-start configuration. */
export type JsonObject = Record<string, unknown>;

/** The one durable technical execution currently owned by a process. */
export type CurrentExecutionRef = { kind: "worker_start"; id: string } | null;

/** Immutable non-secret inputs resolved for a worker-owned turn start. */
export type ResolvedTurnStart =
	| {
			kind: "llm";
			model: {
				profileId: string;
				providerId: string;
				modelId: string;
				thinkingLevel: string;
			};
			/** Frozen provenance used to resolve this prepared start. */
			modelSelectionProvenance?: ModelSelectionProvenance;
			/** Status revision evaluated before preparation. Diagnostic only. */
			availabilityRevision?: number;
			providerOptions: Record<string, string>;
			providerWorkerConfig: { version: number; value: JsonObject } | null;
			piResourceSnapshotDigest: string;
			workerRuntimeProfileId: string;
			piSettings: JsonObject;
	  }
	| { kind: "automatic" };

export type TurnStartKind = "selected_turn" | "retry" | "continue" | "startup_retry";

export interface TurnStartContinuation {
	continueFromPiEntryId: string;
	continuePrompt: string;
	savedPrimaryLeafEntryId: string | null;
}

export type TurnStartPreparationFailureCode =
	| "invalid_model_configuration"
	| "model_required"
	| "model_unavailable"
	| "model_stale"
	| "provider_options_required"
	| "provider_preflight_failed";

export type TurnStartRecordState =
	| {
			kind: "preparation_failed";
			requestedModelProfileId: string | null;
			providerOptions: Record<string, string>;
			code: TurnStartPreparationFailureCode;
			safeSummary: string;
			modelSelectionProvenance?: ModelSelectionProvenance;
			availabilityRevision?: number;
	  }
	| { kind: "starting"; start: ResolvedTurnStart }
	| {
			kind: "bootstrap_failed";
			start: ResolvedTurnStart;
			failedWorkerLeaseId: string | null;
			code: string;
			safeSummary: string;
	  }
	| {
			kind: "accepted";
			start: ResolvedTurnStart;
			turnRecordId: string;
			acceptedWorkerLeaseId: string;
	  }
	| { kind: "superseded"; start: ResolvedTurnStart | null };

/** Durable preparation for a single worker-owned selected turn, not an attempt. */
export interface TurnStartRecord {
	id: string;
	instanceId: string;
	turnId: TurnId;
	turnType: Extract<ProcessTurnType, "llm" | "automatic">;
	/** Reserved id used when, and only when, this start is accepted. */
	proposedTurnRecordId: string;
	startKind: TurnStartKind;
	recoveryTurnRecordId: string | null;
	continuation: TurnStartContinuation | null;
	state: TurnStartRecordState;
	createdAt: string;
	updatedAt: string;
}

/** Tree positioning selected during bootstrap, before a turn is accepted. */
export interface PreparedTurnStart {
	pathType: ProcessTurnRecordPathType;
	/** Durable authored context mode used to reconcile pre-prompt positioning and compaction. */
	contextMode: LlmContextMode;
	startTarget: ProcessTurnStartTarget;
	forkPiEntryId: string | null;
}

export type LlmContextMode = "full" | "compacted" | "fresh" | "fresh_seeded";

/** Immutable, lease-correlated proof of successful worker bootstrap. */
export type WorkerBootstrapReceipt =
	| {
			kind: "llm";
			startRecordId: string;
			workerLeaseId: string;
			receiptEpoch: string;
			verifiedResourceSnapshotDigest: string;
			credentialRevision: number | null;
			loadedResourceIds: string[];
			resolvedModel: { providerId: string; modelId: string };
			preparedStart: PreparedTurnStart | null;
			readyAt: string;
	  }
	| {
			kind: "automatic";
			startRecordId: string;
			workerLeaseId: string;
			receiptEpoch: string;
			readyAt: string;
	  };

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

export function isProcessSelectedTurnModelSource(
	value: unknown,
): value is ProcessSelectedTurnModelSource {
	return PROCESS_SELECTED_TURN_MODEL_SOURCES.includes(value as ProcessSelectedTurnModelSource);
}

export interface ProcessCustomizableFields {
	title?: string | null;
	externalId?: string | null;
	externalUrl?: string | null;
	metadata?: Record<string, unknown> | null;
	defaultModelProfileId?: string | null;
	initialDefaultModelProfileId?: string | null;
	turnConfigsJson?: string | null;
	selectedTurnModelProfileId?: string | null;
	selectedTurnModelKind?: ModelSelectionKind | null;
	selectedTurnModelSource?: ProcessSelectedTurnModelSource | null;
}

export interface ProcessInstance {
	id: string;
	/** Canonical process identifier from the extension catalog. */
	processId: string;
	/** Durable pointer to the currently selected business turn, if any. */
	selectedTurnId: TurnId | null;
	/** High-level lifecycle bucket for scheduling and operator state. */
	lifecycleStatus: ProcessLifecycleStatus;
	/** Single durable technical execution reference; null for waiting/terminal states. */
	currentExecution: CurrentExecutionRef;
	planRevision: number;
	/** Short operator-facing process title used in process lists and related UI. */
	title: string | null;
	/** Provider-agnostic external reference, such as a work item key or change path. */
	externalId: string | null;
	/** URL to the external resource, if applicable. */
	externalUrl: string | null;
	/** Extension-owned JSON metadata blob. */
	metadata: Record<string, unknown> | null;
	/** Instance-scoped default model profile used when no turn override applies. */
	defaultModelProfileId?: string | null;
	/** Effective default model at creation time, retained for historical inspection. */
	initialDefaultModelProfileId?: string | null;
	/** JSON-serialized per-turn runtime config overrides for this instance. */
	turnConfigsJson?: string | null;
	/** Frozen effective model profile for the currently selected LLM turn, if any. */
	selectedTurnModelProfileId?: string | null;
	/** Explicit operator intent or inherited policy resolution for the selected model. */
	selectedTurnModelKind?: ModelSelectionKind | null;
	/** Resolution path that selected `selectedTurnModelProfileId`; null for empty selections. */
	selectedTurnModelSource?: ProcessSelectedTurnModelSource | null;
	/** JSON-serialized process params. */
	paramsJson: string | null;
	/** JSON-serialized process state. */
	stateJson: string | null;
	createdAt: string;
	updatedAt: string;
	/** Set once when the process first reaches a terminal lifecycle status. */
	closedAt?: string | null;
}

export interface ProcessProject {
	id: string;
	instanceId: string;
	key: string;
	/** Repository source identifier. May be a remote URL or a local filesystem path. */
	repoLocator: string;
	repoLocatorKind: RepoLocatorKind;
	baseBranch: string;
	workBranch: string | null;
	/** Provider-agnostic external identifier (e.g. MR IID, PR number). */
	externalId: string | null;
	/** URL to the external resource (e.g. MR URL, PR URL). */
	externalUrl: string | null;
	/** Extension-owned JSON metadata blob. */
	metadata: Record<string, unknown> | null;
	pipelineStatus: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface ProcessInput {
	id: string;
	instanceId: string;
	sequence: number;
	source: InputSource;
	kind: InputKind;
	target: ProcessInputTarget | null;
	bodyMarkdown: string;
	/** Stable principal that queued this input. Defaults to `SYSTEM_ACTOR`. */
	actor: Actor;
	receivedAt: string;
	consumedAt: string | null;
}

export type LaunchOrigin = "ui" | "programmatic" | "watcher" | "scheduled" | "startup_retry";
export type LaunchRunStatus =
	| "preparing"
	| "process_created"
	| "starting"
	| "completed"
	| "failed"
	| "cancelled";
export type LaunchChecklistStepStatus =
	| "pending"
	| "in_progress"
	| "completed"
	| "failed"
	| "skipped";

/** Presentation-safe durable progress for one process launch attempt. */
export interface LaunchChecklistStep {
	id: string;
	label: string;
	status: LaunchChecklistStepStatus;
	safeSummary?: string;
	startedAt?: string;
	completedAt?: string;
}

/** Durable launch attempt. Secrets and runner identifiers never belong here. */
export interface LaunchRun {
	id: string;
	launcherId: string | null;
	origin: LaunchOrigin;
	instanceId: string | null;
	status: LaunchRunStatus;
	steps: LaunchChecklistStep[];
	createdAt: string;
	updatedAt: string;
	completedAt: string | null;
	revision: number;
}

export type FutureExecutionKind = "launch" | "action";
export type FutureExecutionScheduleKind = "once" | "cron";

export interface FutureExecution {
	id: string;
	kind: FutureExecutionKind;
	scheduleKind: FutureExecutionScheduleKind;
	/** Canonical target process identifier. */
	processId: string;
	/** Populated only for scheduled actions on an existing process instance. */
	instanceId: string | null;
	launcherId: string | null;
	actionId: string | null;
	/** JSON-serialized kind-specific payload. */
	payloadJson: string;
	cronExpression: string | null;
	nextRunAt: string;
	/** Immediate LLM selection caused by this execution, if known. */
	modelSelection?: DurableModelSelection | null;
	/** Structured model-policy block. Blocked rows remain durable. */
	blockedReason?: FutureExecutionBlockReason | null;
	createdAt: string;
	updatedAt: string;
}

export interface ProcessEvent {
	/** Persisted ingestion order. Absent only on legacy in-memory fixtures. */
	eventSequence?: number;
	id: string;
	instanceId: string;
	eventType: string;
	data: Record<string, unknown>;
	createdAt: string;
}

export type ProcessLeafOutcomeSnapshotStatus = "ready" | "capture_error";

export interface ProcessLeafOutcomeSnapshot {
	id: string;
	instanceId: string;
	leafEntryId: string;
	turnRecordId: string | null;
	rendererId: string | null;
	schemaVersion: number | null;
	props: Record<string, unknown> | null;
	fallbackMarkdown: string | null;
	status: ProcessLeafOutcomeSnapshotStatus;
	warningCode: string | null;
	warningMessage: string | null;
	anchoredAt: string;
	createdAt: string;
}

export type ProcessTurnRecordStatus = "running" | "succeeded" | "failed" | "superseded";

export type TurnProgressStepStatus = "incomplete" | "in_progress" | "completed" | "failed";

export interface TurnProgressStep {
	id: string;
	label: string;
	status: TurnProgressStepStatus;
	detail?: string | null;
}

export interface TurnProgressLink {
	id: string;
	label: string;
	url: string;
	kind?: "pull_request" | "merge_request" | "commit" | "pipeline" | "other";
}

/** A complete operator-facing snapshot. Reporters replace, rather than patch, this value. */
export interface TurnProgressReport {
	title: string;
	steps: TurnProgressStep[];
	links?: TurnProgressLink[];
}

/**
 * Structural tree position for a turn record.
 * - `primary`: continue the primary path from the current leaf
 * - `root_branch`: start from the implicit session root with no prior Pi entry context
 * - `leaf_branch`: fork from the current leaf as a side path
 */
export const PROCESS_TURN_RECORD_PATH_TYPES = ["primary", "root_branch", "leaf_branch"] as const;

export type ProcessTurnRecordPathType = (typeof PROCESS_TURN_RECORD_PATH_TYPES)[number];

export interface ProcessTurnRecord {
	id: string;
	instanceId: string;
	turnId: TurnId;
	turnType: ProcessTurnType;
	status: ProcessTurnRecordStatus;
	attemptNumber: number;
	parentTurnRecordId: string | null;
	pathType: ProcessTurnRecordPathType;
	forkPiEntryId: string | null;
	/** Accepted worker-start preparation that created this worker-owned record. */
	turnStartRecordId?: string | null;
	/** Lease whose receipt first authorized this worker-owned record. */
	acceptedWorkerLeaseId?: string | null;
	resultPiEntryId: string | null;
	modelProfileId: string | null;
	modelSelectionProvenance?: ModelSelectionProvenance | null;
	turnResultMarkdown: string | null;
	errorSummary: string | null;
	errorClass: WorkerErrorClass | null;
	startedAt: string;
	endedAt: string | null;
}

export interface WorkerLease {
	id: string;
	instanceId: string;
	workerId: string;
	/** Worker start this physical lease was created to execute. */
	turnStartRecordId?: string | null;
	/** Durable server-owned supervision state for the current worker lease. */
	state: WorkerState;
	/** Server epoch this lease belongs to, used to reject stale snapshot writes. */
	serverEpoch?: string | null;
	/** Hash of the lease-scoped WebSocket connect token. The raw token is never stored. */
	connectTokenHash?: string | null;
	/** Hash of the lease-scoped HTTP session-snapshot credential. The raw token is never stored. */
	snapshotTokenHash?: string | null;
	/** Fingerprint of the effective instance model policy/config snapshot used to start this worker. */
	modelPolicyFingerprint?: string | null;
	/** First valid lease-correlated bootstrap receipt; written once by the server. */
	bootstrapReceipt?: WorkerBootstrapReceipt | null;
	/** Updated from heartbeats for liveness/recovery diagnostics. */
	lastHeartbeatAt: string | null;
	startedAt: string;
	/** First valid server-observed worker handshake. */
	connectedAt?: string | null;
	/** First valid server-observed workspace preparation progress. */
	workspacePreparationStartedAt?: string | null;
	/** First accepted server-observed worker readiness. */
	readyAt?: string | null;
	/** Set once the lease is no longer active for supervision. */
	exitedAt: string | null;
}

/**
 * Durable worker lease states owned by the server.
 * `absent` is conceptual in lifecycle logic and usually represented by
 * the absence of an active lease row.
 */
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
export type ExternalWriteType = string;

export interface ExternalWriteLog {
	id: string;
	instanceId: string;
	writeType: ExternalWriteType;
	dedupKey: string;
	completedAt: string;
	metadata: Record<string, unknown>;
}

/**
 * Returns a human-readable, operator-facing label for the structural path
 * position of a turn record. These labels avoid internal domain terms such
 * as "primary" or "root_branch" in favour of plain descriptions of what the
 * turn is doing relative to the main path.
 */
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
