import {
	type Actor,
	type DurableModelSelection,
	type FutureExecutionBlockReason,
	type InstanceTurnConfigMap,
	type LaunchModelConfigInput,
	normalizeActor,
	normalizeLaunchModelConfigInput,
	type ProcessEvent,
	type ProcessFlowView,
	type ProcessInput,
	type ProcessInstance,
	type ProcessLeafOutcomeSnapshot,
	type ProcessProject,
	type ProcessQuestionRequest,
	type ProcessRowSlot,
	type ProcessSelectedTurnModelSource,
	type ProcessTurnAnnotation,
	type ProcessTurnRecord,
	type ProcessTurnType,
	type QuestionAnswerDraft,
	type SerializedProcessGraph,
	type TurnProgressReport,
	trimToNull,
	type WorkerLease,
} from "@leitwerk-dev/domain";
import * as v from "valibot";
import type {
	ActionFormDefinition,
	ActionFormFieldDefinition,
	FormFieldOptionDefinition,
} from "./form-contract.js";
import type { LauncherValidationError, UiLauncherSummaryBase } from "./launcher-contract.js";
import type {
	PrimaryPathSnapshot,
	PrimaryPathStreamingAssistantSnapshot,
	PrimaryPathToolCallSnapshot,
	PrimaryPathTraceItemSnapshot,
	TurnUsageSnapshot,
} from "./primary-path-snapshot.js";
import {
	err,
	nullableStringSchema,
	ok,
	optionalNullableStringSchema,
	type ParseResult,
	parseLiteral,
	parseSchema,
	unknownRecordSchema,
} from "./protocol.js";
import type { ToolCallRendererDefinition } from "./tool-renderer-contract.js";

export interface AuthMeResponseBody {
	authEnabled: boolean;
	actor: Actor | null;
}

export interface ProcessListItem {
	process: ProcessInstance;
	projects: ProcessProject[];
	workerLease: WorkerLease | null;
	processDisplayName: string | null;
}

export type ScheduleMode = "now" | "once" | "cron";

export type ScheduleConfigInput = {
	mode: ScheduleMode;
	runAt?: string | null;
	cronExpression?: string | null;
};

export interface FutureExecutionBaseSummary {
	id: string;
	kind: "launch" | "action";
	scheduleKind: "once" | "cron";
	processId: string;
	nextRunAt: string;
	cronExpression: string | null;
	title: string;
	subtitle: string;
	status?: "scheduled" | "blocked";
	modelSelection?: DurableModelSelection | null;
	blockedReason?: FutureExecutionBlockReason | null;
}

export type LauncherModelConfigDefaults = LaunchModelConfigInput;

export interface FutureLaunchSummary extends FutureExecutionBaseSummary {
	kind: "launch";
	launcherId: string;
	launcherLabel: string;
	launchTitle: string | null;
	launcherInput: Record<string, unknown>;
	skillIds: string[];
	modelConfig: LauncherModelConfigDefaults;
}

export interface FutureActionSummary extends FutureExecutionBaseSummary {
	kind: "action";
	instanceId: string;
	actionId: string;
	actionLabel: string;
	nextTurnModelProfileId: string | null;
}

export type FutureExecutionSummary = FutureLaunchSummary | FutureActionSummary;

export type ProcessActionFieldDefinition = ActionFormFieldDefinition;
export type ProcessActionFormDefinition = ActionFormDefinition;

export type ProcessActionPreviewSummary = {
	kind: "turn" | "terminal";
	turnId: string | null;
	turnKind: ProcessTurnType | null;
	description: string;
};

export interface ProcessActionSummary {
	id: string;
	label: string;
	description: string | null;
	preview: ProcessActionPreviewSummary | null;
	supportsScheduling: boolean;
	supportsNextTurnModelOverride: boolean;
	form?: ProcessActionFormDefinition;
}

export interface ScheduledActionDetail {
	id: string;
	nextRunAt: string;
	actionId: string;
	actionLabel: string;
	input: Record<string, unknown>;
	nextTurnModelProfileId: string | null;
	status?: "scheduled" | "blocked";
	modelSelection?: DurableModelSelection | null;
	blockedReason?: FutureExecutionBlockReason | null;
	action: ProcessActionSummary;
}

export type ProcessActionModelResolutionSource =
	| ProcessSelectedTurnModelSource
	| "persisted_selection"
	| "none";

export interface ProcessActionModelResolutionPreview {
	status: "resolved" | "none" | "error";
	modelProfileId: string | null;
	source: ProcessActionModelResolutionSource | null;
	error: string | null;
}

export interface ProcessActionWarmPromptCacheContext {
	previousModelProfileId: string;
	compatibleModelProfileIds: readonly string[];
	expiresAt: string;
}

export interface PromptCacheSwitchResolution {
	switchingModelMayBypassPromptCache: boolean;
	recommendedModelProfileId: string | null;
}

export function resolvePromptCacheSwitch(input: {
	context: ProcessActionWarmPromptCacheContext | null | undefined;
	effectiveModelProfileId: string;
	selectableModelProfileIds?: readonly string[];
	now?: number;
}): PromptCacheSwitchResolution {
	const expiresAtMs = input.context ? Date.parse(input.context.expiresAt) : Number.NaN;
	if (
		!input.context ||
		!Number.isFinite(expiresAtMs) ||
		(input.now ?? Date.now()) > expiresAtMs ||
		input.context.compatibleModelProfileIds.includes(input.effectiveModelProfileId)
	) {
		return { switchingModelMayBypassPromptCache: false, recommendedModelProfileId: null };
	}
	const selectableIds = input.selectableModelProfileIds
		? new Set(input.selectableModelProfileIds)
		: null;
	const recommendations = input.context.compatibleModelProfileIds.filter(
		(profileId) => !selectableIds || selectableIds.has(profileId),
	);
	return {
		switchingModelMayBypassPromptCache: true,
		recommendedModelProfileId: recommendations.includes(input.context.previousModelProfileId)
			? input.context.previousModelProfileId
			: (recommendations[0] ?? null),
	};
}

export interface ProcessActionModelPreview {
	kind: "llm_turn" | "not_applicable" | "unavailable";
	turnId: string | null;
	description: string | null;
	resolvedModel?: ProcessActionModelResolutionPreview;
	warmPromptCache?: ProcessActionWarmPromptCacheContext;
	unavailableReason?:
		| "action_not_found"
		| "action_not_visible"
		| "invalid_action_input"
		| "action_failed";
	unavailableMessage?: string | null;
}

export type ProcessExternalSourceSummary = {
	id: string;
	kind: string;
	externalActionId?: string;
	sourceKind?: string;
	label: string | null;
	description: string | null;
};

export type ProcessExternalTriggerSummary = ProcessExternalSourceSummary;

export interface ProcessSelectedTurnSummary {
	turnId: string;
	kind: ProcessTurnType;
	description: string;
	commentary: string | null;
	externalTriggers: ProcessExternalSourceSummary[];
}

export type ModelProfileAvailability = "available" | "unavailable" | "stale";

export type ModelProfileOptionSummary = {
	id: string;
	label: string;
	description: string;
	availability: ModelProfileAvailability;
	safeReason?: string | null;
	checkedAt?: string | null;
};

export interface ProviderOptionChoiceSummary {
	value: string;
	label: string;
}

export interface ProviderOptionFieldSummary {
	id: string;
	label: string;
	required: boolean;
	minLength: number | null;
	maxLength: number | null;
	defaultValue: string | null;
	/** Advisory values. Values outside this list can still be valid. */
	choices: readonly ProviderOptionChoiceSummary[];
}

export interface ModelProviderOptionsResponseBody {
	modelProfileId: string;
	providerId: string;
	fields: readonly ProviderOptionFieldSummary[];
	choicesStatus: "available" | "unavailable";
	choicesUnavailableReason: string | null;
}

export interface ProcessTurnModelConfigurationView {
	turnId: string;
	description: string;
	pathType: string;
	processConfigModelProfileId: string | null;
	instanceModelProfileId: string | null;
	effectiveConfiguredModelProfileId: string | null;
	source: "instance" | "process_config" | "default";
}

export type ProcessModelConfigurationIssueView = {
	code: "invalid_turn_configs_json";
	reason: "invalid_json" | "not_object" | "turn_config_not_object";
	turnId?: string;
};

export interface ProcessModelConfigurationView {
	state:
		| { kind: "ready" }
		| { kind: "blocked"; issues: readonly ProcessModelConfigurationIssueView[] };
	availableProfiles: readonly ModelProfileOptionSummary[];
	effectiveSelectedTurn: {
		turnId: string;
		description: string;
		modelProfileId: string;
		source: ProcessActionModelResolutionSource;
	} | null;
	defaultModel: {
		processConfigModelProfileId: string | null;
		instanceModelProfileId: string | null;
		effectiveModelProfileId: string | null;
		source: "instance" | "process_config" | "catalog_default" | "none";
	};
	turns: readonly ProcessTurnModelConfigurationView[];
}

export type ProcessRunToolParameterView = {
	name: string;
	type: string;
	description: string;
	required: boolean;
};

export type ProcessRunToolView = {
	name: string;
	description: string;
	parameters: readonly ProcessRunToolParameterView[];
};

export type ProcessRunTurnView = {
	turnId: string;
	description: string;
	pathType: string;
	consumedProducts: readonly string[];
	publishedProducts: readonly string[];
	activePiToolNames: readonly string[];
	outcomeActions: readonly ProcessRunToolView[];
};

export type ProcessRunDetailsView = {
	systemPrompt: string | null;
	appendSystemPrompt: string | null;
	availablePiToolNames: readonly string[];
	turns: readonly ProcessRunTurnView[];
};

export interface ProcessLaunchConfigurationParameterView {
	fieldId: string;
	label: string;
	value: string | null;
}

export interface ProcessLaunchConfigurationProjectView {
	key: string;
	repoLocator: string;
	repoLocatorKind: ProcessProject["repoLocatorKind"];
	baseBranch: string;
	workBranch: string | null;
	externalId: string | null;
	externalUrl: string | null;
	pipelineStatus: string | null;
}

export interface ProcessLaunchConfigurationView {
	launcherId: string | null;
	launcherLabel: string | null;
	launcherSchemaTitle: string | null;
	paramsParseError: string | null;
	parameters: readonly ProcessLaunchConfigurationParameterView[];
	projects: readonly ProcessLaunchConfigurationProjectView[];
}

export interface PiSessionUsageSnapshot {
	input: number;
	output: number;
	/** Provider-reported reasoning/thinking tokens. This is a subset of output tokens. */
	reasoning?: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

export type PiSessionTextContentBlock = { type: "text"; text: string };

export type PiSessionThinkingContentBlock = {
	type: "thinking";
	thinking: string;
	redacted?: boolean;
};

export type PiSessionToolCallContentBlock = {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
};

export type PiSessionImageContentBlock = {
	type: "image";
	data: string;
	mimeType: string;
};

export type PiSessionContentBlock =
	| PiSessionTextContentBlock
	| PiSessionThinkingContentBlock
	| PiSessionToolCallContentBlock
	| PiSessionImageContentBlock;

export interface PiSessionMessageRecord {
	role?: string;
	content?: string | PiSessionContentBlock[];
	toolCallId?: string;
	toolName?: string;
	details?: unknown;
	isError?: boolean;
	usage?: PiSessionUsageSnapshot;
	stopReason?: string;
	errorMessage?: string;
	provider?: string;
	model?: string;
	timestamp?: number;
}

export interface PiSessionEntry {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
	message?: PiSessionMessageRecord;
	targetId?: string;
	label?: string;
}

export interface ProcessDiagnosticsData {
	process: ProcessInstance;
	projects: ProcessProject[];
	inputs: ProcessInput[];
	events: ProcessEvent[];
	leafOutcomeSnapshots: ProcessLeafOutcomeSnapshot[];
	turnRecords: ProcessTurnRecord[];
	turnAnnotations: ProcessTurnAnnotation[];
	workerLease: WorkerLease | null;
	processDisplayName: string | null;
	processGraph: SerializedProcessGraph;
	processFlow: ProcessFlowView;
	piSessionEntries: PiSessionEntry[];
	definesLeafOutcome: boolean;
	selectedTurn?: ProcessSelectedTurnSummary | null;
	scheduledAction?: ScheduledActionDetail | null;
	modelConfiguration: ProcessModelConfigurationView;
	runDetails: ProcessRunDetailsView;
	launchConfiguration: ProcessLaunchConfigurationView;
	actions: ProcessActionSummary[];
	toolRenderers: ToolCallRendererDefinition[];
}

export interface ProcessDetailData extends ProcessDiagnosticsData {
	primaryPath: PrimaryPathSnapshot;
}

export interface LauncherModelConfigSchema {
	availableProfiles: readonly ModelProfileOptionSummary[];
	llmTurns: ReadonlyArray<{
		turnId: string;
		description: string;
	}>;
}

export type LauncherDefaultModelPreview = {
	source: "instance_default" | "process_config_default" | "catalog_default" | "none";
	profile: ModelProfileOptionSummary | null;
};

export interface LauncherTurnModelConfigPreview {
	turnId: string;
	description: string;
	effective: {
		source: ProcessActionModelResolutionSource;
		profile: ModelProfileOptionSummary | null;
	};
}

export type LauncherModelConfigPreview = {
	defaultModel: LauncherDefaultModelPreview;
	turns: readonly LauncherTurnModelConfigPreview[];
};

export type UiLauncherSummary = UiLauncherSummaryBase & {
	modelConfigSchema?: LauncherModelConfigSchema;
	processFlow?: ProcessFlowView;
};

export type ProcessRetryConfig = {
	launcherId: string;
	title: string | null;
	launcherInput: Record<string, unknown>;
	skillIds: string[];
	modelConfig: LauncherModelConfigDefaults;
};

export type WatcherLaunchModelSummary = {
	defaultModelProfileId: string | null;
	turnConfigs: Array<{ turnId: string; modelProfileId: string | null }>;
};

export interface WatcherPresentationField {
	label: string;
	value: string;
	format?: "text" | "code";
}

export interface WatcherSummary {
	processId: string;
	processDisplayName: string;
	watcherId: string;
	label: string;
	description: string;
	sourceId: string;
	sourceLabel: string;
	enabled: boolean;
	configPath: string;
	targetSummary: string;
	details: WatcherPresentationField[];
	launchModel: WatcherLaunchModelSummary;
}

export interface SkillUsageSummary {
	attachedAllTime: number;
	attachedLast30Days: number;
	invokedAllTime: number;
	invokedLast30Days: number;
}

export interface SkillRepositorySummary {
	id: string;
	label: string;
	url: string;
	ref: string;
	path: string;
	lastRefreshedAt: string | null;
	error: string | null;
}

export interface SkillCatalogSummary {
	id: string;
	label: string;
	description: string | null;
	updateAvailable: boolean;
	modelInvocable: boolean;
	usage: SkillUsageSummary;
}

export interface SkillCatalogItem extends SkillCatalogSummary {
	repositoryId: string;
	sourcePath: string;
	sourceRevision: string;
	registered: boolean;
	stale: boolean;
}

export interface InstalledSkillCatalogItem extends SkillCatalogSummary {
	activeRevisionId: string;
	activeSourceRevision: string | null;
	sourceRepositoryId: string | null;
}

export interface SkillRevisionSummary {
	id: string;
	sourceRevision: string | null;
	importedAt: string;
	active: boolean;
}

export interface SkillUsageProcessSummary {
	instanceId: string;
	title: string;
	attachedAt: string;
	invocationCount: number;
	lastInvokedAt: string | null;
}

export interface SkillCatalogDetail extends SkillCatalogItem {
	skillMarkdown: string;
	processes: SkillUsageProcessSummary[];
}

export interface InstalledSkillCatalogDetail extends InstalledSkillCatalogItem {
	skillMarkdown: string;
	processes: SkillUsageProcessSummary[];
	revisions: SkillRevisionSummary[];
}

export type ErrorResponseBody = { error?: string | null; code?: string | null };

export type ProcessesListResponseBody = {
	processes: ProcessListItem[];
	futureExecutions: FutureExecutionSummary[];
};

export interface ProcessOverviewItem extends ProcessRowSlot {
	processDisplayName: string | null;
	/** Nullable durable title before external-id/instance-id display fallback. */
	processTitle: string | null;
	initialPromptPreview: string | null;
	createdAt: string;
	updatedAt: string;
	closedAt: string | null;
}

interface FutureExecutionOverviewItemBase {
	id: string;
	scheduleKind: "once" | "cron";
	processId: string;
	nextRunAt: string;
	cronExpression: string | null;
	title: string;
	initialPromptPreview: string | null;
	status?: "scheduled" | "blocked";
	blockedReason?: FutureExecutionBlockReason | null;
}

export interface FutureLaunchOverviewItem extends FutureExecutionOverviewItemBase {
	kind: "launch";
	instanceId: null;
	launcherId: string;
	launcherLabel: string;
}

export interface FutureActionOverviewItem extends FutureExecutionOverviewItemBase {
	kind: "action";
	instanceId: string;
	actionId: string;
	actionLabel: string;
}

export type FutureExecutionOverviewItem = FutureLaunchOverviewItem | FutureActionOverviewItem;

export interface ProcessesOverviewResponseBody {
	processes: ProcessOverviewItem[];
	futureExecutions: FutureExecutionOverviewItem[];
	/** True when the bounded sidebar response omitted less-recent rows. */
	truncated: boolean;
}

export interface ProcessBrowsePagination {
	limit: number;
	offset: number;
	total: number;
	processTotal: number;
	futureExecutionTotal: number;
	hasMore: boolean;
}

export interface ProcessBrowseFacets {
	statusCounts: Record<
		"all" | "running" | "scheduled" | "needs_attention" | "completed" | "aborted",
		number
	>;
	processTypes: Array<{ value: string; label: string; count: number }>;
}

export type ProcessBrowseItem =
	| { kind: "process"; item: ProcessOverviewItem }
	| { kind: "future"; item: FutureExecutionOverviewItem };

export interface ProcessBrowseResponseBody {
	/** Globally sorted page. The browser must preserve this server-owned order. */
	items: ProcessBrowseItem[];
	pagination: ProcessBrowsePagination;
	facets: ProcessBrowseFacets;
}

export type TurnTraceToolCallSnapshot = Omit<PrimaryPathToolCallSnapshot, "result"> & {
	resultText: string | null;
	truncated: boolean;
};

export type TurnPiInputPartRole = "user" | "system" | "unknown";

export interface TurnPiInputPart {
	role: TurnPiInputPartRole;
	text: string;
	createdAt: string;
}

export interface TurnPiInputSnapshot {
	parts: TurnPiInputPart[];
	fullPrompt: string;
	createdAt: string;
	userInput?: string | null;
}

export interface TurnTraceSnapshot {
	assistant: PrimaryPathStreamingAssistantSnapshot;
	toolCalls: TurnTraceToolCallSnapshot[];
	traceItems: PrimaryPathTraceItemSnapshot[];
	usage: TurnUsageSnapshot | null;
	piInput: TurnPiInputSnapshot | null;
}

export interface TurnTracePreview {
	turnRecordId: string;
	assistantTextPreview: string;
	assistantTextTruncated: boolean;
	thinkingPreview: string;
	thinkingPreviewTruncated: boolean;
	toolCallCount: number;
	traceItemCount: number;
	hasReasoningDetails: boolean;
	usage: TurnUsageSnapshot | null;
	piInput: { createdAt: string | null; partCount: number; userInputPreview: string | null } | null;
}

export type ProcessTimelineTurnPresentation =
	| "llm_turn"
	| "automatic_turn"
	| "operator_decision"
	| "external_trigger";

export interface ProcessTimelineTurnSummary {
	id: string;
	turnId: string;
	turnType: ProcessTurnType;
	displayTurn: string;
	outcome: string;
	summary: string;
	output: string;
	turnResultMarkdown: string;
	pathType: ProcessTurnRecord["pathType"];
	createdAt: string;
	presentation: ProcessTimelineTurnPresentation;
	status: "completed" | "in_progress";
	modelProfileId: string | null;
	/** Durable lineage needed by the chronicle rail and input correlation. */
	attemptNumber: number;
	parentTurnRecordId: string | null;
	startedAt: string;
	endedAt: string | null;
	actionSource: "ui" | "external" | "scheduled" | null;
	progress?: TurnProgressReport | null;
}

export type ProcessTimelineInputSummary = Pick<
	ProcessInput,
	"id" | "sequence" | "source" | "kind" | "bodyMarkdown" | "receivedAt" | "consumedAt"
>;

export interface ProcessExternalTriggerSignal {
	triggerId: string;
	state: "error" | "armed" | "triggered" | "waiting";
	occurredAt: string | null;
	secondaryDetail: string | null;
}

export interface ProcessTimelineSnapshot {
	prompt: { text: string | null; createdAt: string | null };
	turns: ProcessTimelineTurnSummary[];
	tracePreviewsByTurnRecordId: Record<string, TurnTracePreview>;
	inputs: ProcessTimelineInputSummary[];
	externalTriggerSignals: ProcessExternalTriggerSignal[];
}

export interface CurrentErrorSummary {
	title: string;
	summary: string;
	guidance?: string;
	technicalDetail?: string | null;
}

export interface CurrentTurnRecoverySummary extends CurrentErrorSummary {
	turnRecordId: string;
	defaultContinuePrompt: string;
	canContinue: boolean;
	supportsModelOverride: boolean;
	defaultModelProfileId: string | null;
	providerOptions: Record<string, string>;
}

export interface StartupRecoverySummary extends CurrentErrorSummary {
	startRecordId: string;
	kind: "preparation_failed" | "bootstrap_failed";
	action: "choose_model" | "retry_startup";
	defaultModelProfileId: string | null;
	providerOptions: Record<string, string>;
}

export type CurrentProcessErrorSummary = CurrentErrorSummary;

export interface ProcessUsageEstimateSnapshot {
	usage: TurnUsageSnapshot;
	includesLiveTurn: boolean;
	totalLlmTurnCount: number;
	coveredTurnCount: number;
	missingUsageTurnCount: number;
	missingCostTurnCount: number;
	isPartial: boolean;
}

export interface PrimaryPathUiSnapshot extends PrimaryPathSnapshot {
	entryCount: number;
	entriesOmitted: true;
}

export type ProcessUiSnapshotProcess = Pick<
	ProcessInstance,
	| "id"
	| "processId"
	| "selectedTurnId"
	| "lifecycleStatus"
	| "currentExecution"
	| "planRevision"
	| "title"
	| "externalId"
	| "externalUrl"
	| "initialDefaultModelProfileId"
	| "createdAt"
	| "updatedAt"
	| "closedAt"
>;

/**
 * Initial render contract for process detail. Raw process events, inputs,
 * session entries, projects, and full durable records belong to diagnostics;
 * this DTO carries only browser-facing projections.
 */
export interface ProcessDetailUiSnapshotResponseBody {
	process: ProcessUiSnapshotProcess;
	/** Durable requests in Chronicle order; at most one is open for the current turn. */
	questionRequests: ProcessQuestionRequest[];
	leafOutcomeSnapshots: ProcessLeafOutcomeSnapshot[];
	processDisplayName: string | null;
	processFlow: ProcessFlowView;
	definesLeafOutcome: boolean;
	selectedTurn: ProcessSelectedTurnSummary | null;
	scheduledAction: ScheduledActionDetail | null;
	modelConfiguration: ProcessModelConfigurationView;
	runDetails: ProcessRunDetailsView;
	launchConfiguration: ProcessLaunchConfigurationView;
	actions: ProcessActionSummary[];
	toolRenderers: ToolCallRendererDefinition[];
	primaryPath: PrimaryPathUiSnapshot;
	timeline: ProcessTimelineSnapshot;
	instanceTree: ProcessInstanceTreeResponseBody;
	recovery: CurrentTurnRecoverySummary | null;
	startupRecovery: StartupRecoverySummary | null;
	processError: CurrentProcessErrorSummary | null;
	usageEstimate: ProcessUsageEstimateSnapshot | null;
	persistedModelSelectionWarning: string | null;
	session: { signature: string | null };
}

export type InstanceTreeTurnResultState = "succeeded" | "failed" | "aborted" | "pending";

/** Redacted, semantic process history. Pi message/activity categories are never exposed. */
export interface InstanceTreeNodeSummary {
	id: string;
	parentId: string | null;
	label: string;
	pathType: "primary" | "root_branch" | "leaf_branch";
	resultState: InstanceTreeTurnResultState;
	timestamp: string;
}

export interface InstanceTreeEdgeSummary {
	id: string;
	sourceNodeId: string;
	targetNodeId: string | null;
	hasContext: boolean;
	productLabels: readonly string[];
	actionLabel: string | null;
	endState: "not_applied" | "completed" | null;
}

export interface ProcessInstanceTreeResponseBody {
	currentLeafId: string | null;
	nodes: InstanceTreeNodeSummary[];
	edges: InstanceTreeEdgeSummary[];
}

export interface TurnReasoningDetailResponseBody {
	instanceId: string;
	turnRecordId: string;
	sessionSignature: string | null;
	reasoning: TurnTraceSnapshot;
}

export interface SubmitQuestionAnswersRequestBody {
	draft: QuestionAnswerDraft[];
}

export type QuestionRequestMutationResponseBody = {
	request: ProcessQuestionRequest;
};

export type FutureExecutionDetailResponseBody = FutureExecutionSummary;

export type LaunchersResponseBody = { launchers: UiLauncherSummary[] };

export type WatchersResponseBody = { watchers: WatcherSummary[] };
export type SkillCatalogDetailResponseBody = { skill: SkillCatalogDetail };
export type InstalledSkillCatalogDetailResponseBody = { skill: InstalledSkillCatalogDetail };
export type SkillsCatalogResponseBody = {
	repositories: SkillRepositorySummary[];
	availableSkills: SkillCatalogItem[];
	installedSkills: InstalledSkillCatalogItem[];
};

export interface LauncherDefaultsResponseBody {
	defaults: Record<string, unknown>;
	title: string | null;
	modelConfig: LauncherModelConfigDefaults;
	warnings?: LauncherValidationError[];
}

export type LauncherOptionsResponseBody = {
	options: Record<string, readonly FormFieldOptionDefinition[]>;
};

export type LauncherRecentValuesResponseBody = {
	values: Record<string, readonly string[]>;
};

export type LauncherModelConfigPreviewResponseBody = { preview: LauncherModelConfigPreview };

export interface LauncherMutationResponseBody {
	kind?: "scheduled";
	process?: ProcessInstance | null;
	futureExecution?: FutureLaunchSummary | null;
	projects?: ProcessProject[];
	errors?: LauncherValidationError[];
	error?: string | null;
}

export type ScheduledActionMutationResponseBody = {
	kind?: "scheduled";
	scheduledAction?: ScheduledActionDetail | null;
	error?: string | null;
};

export type ProcessRetryConfigResponseBody = ProcessRetryConfig;

export type ProcessActionModelPreviewResponseBody = { preview: ProcessActionModelPreview };

export type ProcessDiagnosticsResponseBody = ProcessDiagnosticsData;

export type PrimaryPathSnapshotResponseBody = PrimaryPathSnapshot;

export type CronPreviewResponseBody = { nextRunAt: string };

type ParsedLauncherRequestBody = {
	title: string | null;
	titleProvided: boolean;
	launcherInput: Record<string, unknown>;
	launcherInputProvided: boolean;
	skillIds?: string[];
	modelConfig: LauncherModelConfigDefaults;
	modelConfigProvided: boolean;
	schedule: ParsedScheduleRequest;
	scheduleProvided: boolean;
};

type ParsedActionRequestBody = {
	input: Record<string, unknown>;
	inputProvided: boolean;
	nextTurnModelProfileId?: string | null;
	nextTurnModelProfileIdProvided: boolean;
	schedule: ParsedScheduleRequest;
	scheduleProvided: boolean;
};

const SCHEDULE_MODES = ["now", "once", "cron"] as const;
const PROCESS_LIFECYCLE_STATUSES = [
	"discovered",
	"active",
	"waiting",
	"error",
	"completed",
	"aborted",
] as const;
const launcherStructuredBodySchema = v.strictObject({
	title: v.optional(nullableStringSchema),
	launcherInput: v.optional(unknownRecordSchema),
	skillIds: v.optional(v.array(v.string())),
	modelConfig: v.optional(v.unknown()),
	schedule: v.optional(v.unknown()),
});
const actionStructuredBodySchema = v.strictObject({
	input: v.optional(unknownRecordSchema),
	nextTurnModelProfileId: optionalNullableStringSchema,
	schedule: v.optional(v.unknown()),
});
const futureLaunchPayloadInputSchema = v.object({
	launcherInput: v.optional(v.nullable(unknownRecordSchema)),
	modelConfig: v.optional(v.unknown()),
	actor: v.optional(v.nullable(unknownRecordSchema)),
	launchPlan: v.object({
		launcherId: v.string(),
		processId: v.string(),
		handoffDedupKey: optionalNullableStringSchema,
		processInput: v.object({
			processId: v.string(),
			selectedTurnId: optionalNullableStringSchema,
			lifecycleStatus: v.picklist(PROCESS_LIFECYCLE_STATUSES),
			title: optionalNullableStringSchema,
			externalId: optionalNullableStringSchema,
			externalUrl: optionalNullableStringSchema,
			metadata: v.optional(v.nullable(unknownRecordSchema)),
			defaultModelProfileId: optionalNullableStringSchema,
			turnConfigsJson: optionalNullableStringSchema,
			selectedTurnModelProfileId: optionalNullableStringSchema,
			selectedTurnModelKind: v.optional(v.nullable(v.picklist(["explicit", "inherited"]))),
			selectedTurnModelSource: v.optional(
				v.nullable(
					v.picklist([
						"action_override",
						"launch_override",
						"instance_turn_config",
						"process_config_turn",
						"instance_default",
						"process_config_default",
						"catalog_default",
						"legacy_persisted",
					]),
				),
			),
			paramsJson: optionalNullableStringSchema,
			stateJson: optionalNullableStringSchema,
		}),
		titleSourceFields: v.optional(
			v.nullable(v.array(v.object({ label: v.string(), value: v.string() }))),
		),
		projectInputs: v.optional(
			v.nullable(
				v.array(
					v.object({
						key: v.string(),
						repoLocator: v.string(),
						baseBranch: v.string(),
						workBranch: optionalNullableStringSchema,
						externalId: optionalNullableStringSchema,
						externalUrl: optionalNullableStringSchema,
						metadata: v.optional(v.nullable(unknownRecordSchema)),
					}),
				),
			),
		),
		startTurnId: optionalNullableStringSchema,
	}),
	selectedSkillIds: v.optional(v.array(v.string())),
	resourceSelections: v.optional(
		v.array(v.object({ skillId: v.string(), revisionId: v.string() })),
	),
});
const futureActionPayloadInputSchema = v.object({
	input: v.optional(v.nullable(unknownRecordSchema)),
	nextTurnModelProfileId: optionalNullableStringSchema,
	actionLabel: optionalNullableStringSchema,
	actor: v.optional(v.nullable(unknownRecordSchema)),
});

export type ParsedScheduleRequest =
	| { mode: "now" }
	| { mode: "once"; runAt: string }
	| { mode: "cron"; cronExpression: string };
type ValidatedScheduleRequest =
	| { mode: "now"; nextRunAt: null; cronExpression: null }
	| { mode: "once"; nextRunAt: string; cronExpression: null }
	| { mode: "cron"; nextRunAt: string; cronExpression: string };

type FutureLaunchPayloadBase = v.InferOutput<typeof futureLaunchPayloadInputSchema>;
type FutureActionPayloadBase = v.InferOutput<typeof futureActionPayloadInputSchema>;
const cloneUnknownRecord = (value?: Record<string, unknown> | null) =>
	value ? { ...value } : null;
const cloneTurnConfigMap = (turnConfigs: InstanceTurnConfigMap = {}) =>
	Object.fromEntries(
		Object.entries(turnConfigs as Record<string, InstanceTurnConfigMap[string]>).map(
			([turnId, turnConfig]) => [turnId, { ...turnConfig }],
		),
	) as InstanceTurnConfigMap;
const normalizeFutureLaunchPayload = (payload: FutureLaunchPayloadBase) => {
	const modelConfig = normalizeLaunchModelConfigInput(
		(payload.modelConfig ?? {}) as LaunchModelConfigInput,
	);
	return {
		launcherInput: cloneUnknownRecord(payload.launcherInput) ?? {},
		modelConfig: {
			defaultModelProfileId: modelConfig.defaultModelProfileId ?? null,
			turnConfigs: cloneTurnConfigMap(modelConfig.turnConfigs),
		},
		actor: normalizeActor(payload.actor),
		selectedSkillIds: [
			...(payload.selectedSkillIds ??
				payload.resourceSelections?.map(({ skillId }) => skillId) ??
				[]),
		],
		resourceSelections: (payload.resourceSelections ?? []).map((selection) => ({ ...selection })),
		launchPlan: {
			launcherId: payload.launchPlan.launcherId,
			processId: payload.launchPlan.processId,
			handoffDedupKey: trimToNull(payload.launchPlan.handoffDedupKey) ?? null,
			processInput: {
				processId: payload.launchPlan.processInput.processId,
				selectedTurnId: payload.launchPlan.processInput.selectedTurnId ?? null,
				lifecycleStatus: payload.launchPlan.processInput.lifecycleStatus,
				title: payload.launchPlan.processInput.title ?? null,
				externalId: payload.launchPlan.processInput.externalId ?? null,
				externalUrl: payload.launchPlan.processInput.externalUrl ?? null,
				metadata: cloneUnknownRecord(payload.launchPlan.processInput.metadata),
				defaultModelProfileId: payload.launchPlan.processInput.defaultModelProfileId ?? null,
				turnConfigsJson: payload.launchPlan.processInput.turnConfigsJson ?? null,
				selectedTurnModelProfileId:
					payload.launchPlan.processInput.selectedTurnModelProfileId ?? null,
				selectedTurnModelKind: payload.launchPlan.processInput.selectedTurnModelKind ?? null,
				selectedTurnModelSource: payload.launchPlan.processInput.selectedTurnModelSource ?? null,
				paramsJson: payload.launchPlan.processInput.paramsJson ?? null,
				stateJson: payload.launchPlan.processInput.stateJson ?? null,
			},
			titleSourceFields: (payload.launchPlan.titleSourceFields ?? []).map((field) => ({
				...field,
			})),
			projectInputs: (payload.launchPlan.projectInputs ?? []).map((project) => ({
				key: project.key,
				repoLocator: project.repoLocator,
				baseBranch: project.baseBranch,
				workBranch: project.workBranch ?? null,
				externalId: project.externalId ?? null,
				externalUrl: project.externalUrl ?? null,
				metadata: cloneUnknownRecord(project.metadata),
			})),
			startTurnId: payload.launchPlan.startTurnId ?? null,
		},
	};
};
const normalizeFutureActionPayload = (payload: FutureActionPayloadBase) => ({
	input: cloneUnknownRecord(payload.input) ?? {},
	nextTurnModelProfileId: trimToNull(payload.nextTurnModelProfileId) ?? null,
	actionLabel: trimToNull(payload.actionLabel) ?? null,
	actor: normalizeActor(payload.actor),
});

export type FutureLaunchPayload = ReturnType<typeof normalizeFutureLaunchPayload>;
export type FutureActionPayload = ReturnType<typeof normalizeFutureActionPayload>;

function hasOwn(object: Record<string, unknown>, key: string): boolean {
	return Object.hasOwn(object, key);
}

function parseJsonPayload(payloadJson: string, context: string): ParseResult<unknown> {
	try {
		return ok(JSON.parse(payloadJson));
	} catch {
		return err(`${context} must be valid JSON`);
	}
}

function parseRecord(value: unknown, context: string): ParseResult<Record<string, unknown>> {
	return parseSchema(unknownRecordSchema, value, context);
}

function parseLauncherTurnConfigMap(
	value: unknown,
	context: string,
): ParseResult<InstanceTurnConfigMap> {
	const record = parseRecord(value, context);
	if (!record.ok) {
		return record;
	}
	const turnConfigs: InstanceTurnConfigMap = {};
	for (const [turnId, turnConfigValue] of Object.entries(record.value)) {
		const turnConfig = parseRecord(turnConfigValue, `${context}.${turnId}`);
		if (!turnConfig.ok) {
			return turnConfig;
		}
		const modelProfileId =
			trimToNull(turnConfig.value.modelProfileId) ?? trimToNull(turnConfig.value.model_profile);
		turnConfigs[turnId] = modelProfileId ? { modelProfileId } : {};
	}
	return ok(turnConfigs);
}

export function parseScheduleRequestInput(value: unknown): ParseResult<ParsedScheduleRequest> {
	if (value === undefined || value === null) {
		return ok({ mode: "now" });
	}
	const record = parseRecord(value, "schedule");
	if (!record.ok) {
		return record;
	}
	const mode = parseLiteral(record.value.mode ?? "now", SCHEDULE_MODES, "schedule.mode");
	if (!mode.ok || mode.value === "now") {
		return mode.ok ? ok({ mode: "now" }) : mode;
	}
	if (mode.value === "once") {
		const runAt = typeof record.value.runAt === "string" ? record.value.runAt : null;
		return runAt && !Number.isNaN(Date.parse(runAt))
			? ok({ mode: "once", runAt: new Date(runAt).toISOString() })
			: err("runAt must be a valid ISO datetime");
	}
	const cronExpression = trimToNull(record.value.cronExpression);
	return cronExpression
		? ok({ mode: "cron", cronExpression })
		: err("cronExpression is required for cron schedules");
}

export function validateScheduleRequestInput(
	schedule: ParsedScheduleRequest,
	allowedModes: readonly ScheduleMode[],
	options: {
		now?: () => Date;
		resolveCronNextRunAt?: (expression: string, now: Date) => string;
	} = {},
): ParseResult<ValidatedScheduleRequest> {
	if (!allowedModes.includes(schedule.mode)) {
		return err(`Unsupported schedule mode '${schedule.mode}'`);
	}
	if (schedule.mode === "now") {
		return ok({ mode: "now", nextRunAt: null, cronExpression: null });
	}
	const now = options.now ?? (() => new Date());
	if (schedule.mode === "once") {
		const runAt = new Date(schedule.runAt);
		return Number.isNaN(runAt.getTime())
			? err("runAt must be a valid ISO datetime")
			: runAt.getTime() <= now().getTime()
				? err("Scheduled time must be in the future")
				: ok({ mode: "once", nextRunAt: runAt.toISOString(), cronExpression: null });
	}
	if (!options.resolveCronNextRunAt) {
		return err("resolveCronNextRunAt is required for cron schedules");
	}
	try {
		return ok({
			mode: "cron",
			nextRunAt: options.resolveCronNextRunAt(schedule.cronExpression, now()),
			cronExpression: schedule.cronExpression,
		});
	} catch (error) {
		return err(error instanceof Error ? error.message : "Invalid cron expression");
	}
}

export function parseLauncherTurnConfigsJson(
	turnConfigsJson: string | null | undefined,
): ParseResult<InstanceTurnConfigMap> {
	if (!turnConfigsJson) {
		return ok({});
	}
	const parsed = parseJsonPayload(turnConfigsJson, "turnConfigsJson");
	return parsed.ok ? parseLauncherTurnConfigMap(parsed.value, "turnConfigsJson") : parsed;
}

export function parseLauncherInputJson(
	launcherInputJson: string | null | undefined,
	context = "launcherInputJson",
): ParseResult<Record<string, unknown>> {
	if (launcherInputJson === undefined || launcherInputJson === null) {
		return ok({});
	}
	const parsed = parseJsonPayload(launcherInputJson, context);
	return parsed.ok ? parseRecord(parsed.value, context) : parsed;
}

export function parseLauncherModelConfigInput(
	value: unknown,
	context = "modelConfig",
): ParseResult<LaunchModelConfigInput> {
	if (value === undefined || value === null) {
		return ok({});
	}
	const record = parseRecord(value, context);
	if (!record.ok) {
		return record;
	}
	const defaultModelProfileId = trimToNull(record.value.defaultModelProfileId);
	if (
		hasOwn(record.value, "defaultModelProfileId") &&
		record.value.defaultModelProfileId !== null &&
		typeof record.value.defaultModelProfileId !== "string"
	) {
		return err(`${context}.defaultModelProfileId must be a string or null`);
	}
	const turnConfigs =
		record.value.turnConfigs === undefined
			? ok(undefined)
			: parseLauncherTurnConfigMap(record.value.turnConfigs, `${context}.turnConfigs`);
	return turnConfigs.ok
		? ok(
				normalizeLaunchModelConfigInput({
					...(defaultModelProfileId ? { defaultModelProfileId } : {}),
					...(turnConfigs.value ? { turnConfigs: turnConfigs.value } : {}),
				}),
			)
		: turnConfigs;
}

function hasInlineScheduleFields(object: Record<string, unknown>): boolean {
	return hasOwn(object, "mode") || hasOwn(object, "runAt") || hasOwn(object, "cronExpression");
}

export function parseLauncherRequestBody(value: unknown): ParseResult<ParsedLauncherRequestBody> {
	if (value === undefined || value === null) {
		return ok({
			title: null,
			titleProvided: false,
			launcherInput: {},
			launcherInputProvided: false,
			modelConfig: {},
			modelConfigProvided: false,
			schedule: { mode: "now" },
			scheduleProvided: false,
		});
	}
	const record = parseRecord(value, "launcher request body");
	if (!record.ok) {
		return record;
	}
	if (
		hasOwn(record.value, "title") ||
		record.value.launcherInput !== undefined ||
		record.value.skillIds !== undefined ||
		record.value.modelConfig !== undefined ||
		record.value.schedule !== undefined
	) {
		if (
			Object.keys(record.value).some(
				(key) =>
					key !== "title" &&
					key !== "launcherInput" &&
					key !== "skillIds" &&
					key !== "modelConfig" &&
					key !== "schedule",
			)
		) {
			return err(
				"launcher request body must use { title, launcherInput, skillIds, modelConfig, schedule }",
			);
		}
		const parsed = parseSchema(launcherStructuredBodySchema, value, "launcher request body");
		if (!parsed.ok) {
			return parsed;
		}
		const modelConfig = parseLauncherModelConfigInput(parsed.value.modelConfig);
		if (!modelConfig.ok) {
			return modelConfig;
		}
		const schedule = parseScheduleRequestInput(parsed.value.schedule);
		if (!schedule.ok) {
			return schedule;
		}
		const skillIds = parsed.value.skillIds ?? [];
		if (new Set(skillIds).size !== skillIds.length) {
			return err("skillIds must not contain duplicates");
		}
		return ok({
			title: parsed.value.title ?? null,
			titleProvided: hasOwn(record.value, "title"),
			launcherInput: parsed.value.launcherInput ?? {},
			launcherInputProvided: hasOwn(record.value, "launcherInput"),
			...(hasOwn(record.value, "skillIds") ? { skillIds: [...skillIds] } : {}),
			modelConfig: modelConfig.value,
			modelConfigProvided: hasOwn(record.value, "modelConfig"),
			schedule: schedule.value,
			scheduleProvided: hasOwn(record.value, "schedule"),
		});
	}
	const modelConfig = parseLauncherModelConfigInput(record.value, "modelConfig");
	if (!modelConfig.ok) {
		return modelConfig;
	}
	const schedule = parseScheduleRequestInput(record.value);
	if (!schedule.ok) {
		return schedule;
	}
	return ok({
		title: null,
		titleProvided: false,
		launcherInput: record.value,
		launcherInputProvided: true,
		modelConfig: modelConfig.value,
		modelConfigProvided: true,
		schedule: schedule.value,
		scheduleProvided: hasInlineScheduleFields(record.value),
	});
}

export function parseActionRequestBody(value: unknown): ParseResult<ParsedActionRequestBody> {
	if (value === undefined || value === null) {
		return ok({
			input: {},
			inputProvided: false,
			nextTurnModelProfileIdProvided: false,
			schedule: { mode: "now" },
			scheduleProvided: false,
		});
	}
	const record = parseRecord(value, "action request body");
	if (!record.ok) {
		return record;
	}
	const nextTurnModelProfileIdProvided = hasOwn(record.value, "nextTurnModelProfileId");
	if (
		record.value.input !== undefined ||
		nextTurnModelProfileIdProvided ||
		record.value.schedule !== undefined
	) {
		if (
			Object.keys(record.value).some(
				(key) => key !== "input" && key !== "nextTurnModelProfileId" && key !== "schedule",
			)
		) {
			return err("action request body must use { input, nextTurnModelProfileId }");
		}
		const parsed = parseSchema(actionStructuredBodySchema, value, "action request body");
		if (!parsed.ok) {
			return parsed;
		}
		const schedule = parseScheduleRequestInput(parsed.value.schedule);
		if (!schedule.ok) {
			return schedule;
		}
		return ok({
			input: parsed.value.input ?? {},
			inputProvided: hasOwn(record.value, "input"),
			nextTurnModelProfileIdProvided,
			schedule: schedule.value,
			scheduleProvided: hasOwn(record.value, "schedule"),
			...(nextTurnModelProfileIdProvided
				? { nextTurnModelProfileId: parsed.value.nextTurnModelProfileId ?? null }
				: {}),
		});
	}
	const schedule = parseScheduleRequestInput(record.value);
	if (!schedule.ok) {
		return schedule;
	}
	return ok({
		input: record.value,
		inputProvided: true,
		nextTurnModelProfileIdProvided,
		schedule: schedule.value,
		scheduleProvided: hasInlineScheduleFields(record.value),
		...(nextTurnModelProfileIdProvided
			? { nextTurnModelProfileId: trimToNull(record.value.nextTurnModelProfileId) }
			: {}),
	});
}

export function serializeFutureLaunchPayload(payload: unknown): string {
	return JSON.stringify(normalizeFutureLaunchPayload(payload as FutureLaunchPayloadBase));
}

export function parseFutureLaunchPayloadObject(
	value: unknown,
	context = "Scheduled launch payload",
): ParseResult<FutureLaunchPayload> {
	const parsed = parseSchema(futureLaunchPayloadInputSchema, value, context);
	return parsed.ok ? ok(normalizeFutureLaunchPayload(parsed.value)) : parsed;
}

export function parseFutureLaunchPayloadJson(
	payloadJson: string,
): ParseResult<FutureLaunchPayload> {
	const parsed = parseJsonPayload(payloadJson, "Scheduled launch payload");
	return parsed.ok ? parseFutureLaunchPayloadObject(parsed.value) : parsed;
}

export function serializeFutureActionPayload(payload: unknown): string {
	return JSON.stringify(normalizeFutureActionPayload(payload as FutureActionPayloadBase));
}

export function parseFutureActionPayloadObject(
	value: unknown,
	context = "Scheduled action payload",
): ParseResult<FutureActionPayload> {
	const parsed = parseSchema(futureActionPayloadInputSchema, value, context);
	return parsed.ok ? ok(normalizeFutureActionPayload(parsed.value)) : parsed;
}

export function parseFutureActionPayloadJson(
	payloadJson: string,
): ParseResult<FutureActionPayload> {
	const parsed = parseJsonPayload(payloadJson, "Scheduled action payload");
	return parsed.ok ? parseFutureActionPayloadObject(parsed.value) : parsed;
}

export type {
	ApiTokenMetadata,
	ApiTokenPolicy,
	ApiTokensResponseBody,
	CreateApiTokenResponseBody,
} from "./api-token-contracts.js";
