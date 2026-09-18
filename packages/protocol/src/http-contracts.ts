import {
	type Actor,
	type DurableModelSelection,
	type FutureExecutionBlockReason,
	type InstanceTurnConfigMap,
	type LaunchModelConfigInput,
	type LaunchRun,
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
	type ProcessToolApprovalRequest,
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
import type { CompactActiveTurnSnapshot } from "./compact-turn-summary.js";
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
import type { UsageCostSnapshot, UsageTokenCounts } from "./usage-snapshot.js";

/** @internal */
export interface StartLaunchRunResponseBody {
	/** @internal */
	launchRunId: string;
	/** @internal */
	instanceId: string | null;
}

/** @internal */
export interface LaunchRunResponseBody {
	/** @internal */
	launchRun: LaunchRun;
}

/** @internal */
export interface ProcessLaunchRunsResponseBody {
	/** @internal */
	launchRuns: LaunchRun[];
}

/** @internal */
export interface AuthMeResponseBody {
	/** @internal */
	authEnabled: boolean;
	/** @internal */
	actor: Actor | null;
}

/** @internal */
export interface SessionTransferOperationView {
	/** @internal */
	attemptId: string;
	/** @internal */
	phase: string;
	/** @internal */
	blocksManualTurns: boolean;
}

/** @internal */
export interface ProcessListItem {
	/** @internal */
	process: ProcessInstance;
	/** @internal */
	projects: ProcessProject[];
	/** @internal */
	workerLease: WorkerLease | null;
	/** @internal */
	processDisplayName: string | null;
}

/** @internal */
export type ScheduleMode = "now" | "once" | "cron";

/** @internal */
export type ScheduleConfigInput = {
	/** @internal */
	mode: ScheduleMode;
	/** @internal */
	runAt?: string | null;
	/** @internal */
	cronExpression?: string | null;
};

/** @internal */
export interface FutureExecutionBaseSummary {
	/** @internal */
	id: string;
	/** @internal */
	kind: "launch" | "action";
	/** @internal */
	scheduleKind: "once" | "cron";
	/** @internal */
	processId: string;
	/** @internal */
	nextRunAt: string;
	/** @internal */
	cronExpression: string | null;
	/** @internal */
	title: string;
	/** @internal */
	subtitle: string;
	/** @internal */
	status?: "scheduled" | "blocked";
	/** @internal */
	modelSelection?: DurableModelSelection | null;
	/** @internal */
	blockedReason?: FutureExecutionBlockReason | null;
}

/** @internal */
export type LauncherModelConfigDefaults = LaunchModelConfigInput;

/** @internal */
export interface FutureLaunchSummary extends FutureExecutionBaseSummary {
	/** @internal */
	kind: "launch";
	/** @internal */
	launcherId: string;
	/** @internal */
	launcherLabel: string;
	/** @internal */
	launchTitle: string | null;
	/** @internal */
	launcherInput: Record<string, unknown>;
	/** @internal */
	skillIds: string[];
	/** @internal */
	modelConfig: LauncherModelConfigDefaults;
}

/** @internal */
export interface FutureActionSummary extends FutureExecutionBaseSummary {
	/** @internal */
	kind: "action";
	/** @internal */
	instanceId: string;
	/** @internal */
	actionId: string;
	/** @internal */
	actionLabel: string;
	/** @internal */
	nextTurnModelProfileId: string | null;
}

/** @internal */
export type FutureExecutionSummary = FutureLaunchSummary | FutureActionSummary;

/** @internal */
export type ProcessActionFieldDefinition = ActionFormFieldDefinition;
/** @internal */
export type ProcessActionFormDefinition = ActionFormDefinition;

/** @internal */
export type ProcessActionPreviewSummary = {
	/** @internal */
	kind: "turn" | "terminal";
	/** @internal */
	turnId: string | null;
	/** @internal */
	turnKind: ProcessTurnType | null;
	/** @internal */
	description: string;
};

/** @internal */
export interface ProcessActionSummary {
	/** @internal */
	id: string;
	/** @internal */
	label: string;
	/** @internal */
	description: string | null;
	/** @internal */
	preview: ProcessActionPreviewSummary | null;
	/** @internal */
	supportsScheduling: boolean;
	/** @internal */
	supportsNextTurnModelOverride: boolean;
	/** @internal */
	form?: ProcessActionFormDefinition;
}

/** @internal */
export interface ScheduledActionDetail {
	/** @internal */
	id: string;
	/** @internal */
	nextRunAt: string;
	/** @internal */
	actionId: string;
	/** @internal */
	actionLabel: string;
	/** @internal */
	input: Record<string, unknown>;
	/** @internal */
	nextTurnModelProfileId: string | null;
	/** @internal */
	status?: "scheduled" | "blocked";
	/** @internal */
	modelSelection?: DurableModelSelection | null;
	/** @internal */
	blockedReason?: FutureExecutionBlockReason | null;
	/** @internal */
	action: ProcessActionSummary;
}

/** @internal */
export type ProcessActionModelResolutionSource =
	| ProcessSelectedTurnModelSource
	| "persisted_selection"
	| "none";

/** @internal */
export interface ProcessActionModelResolutionPreview {
	/** @internal */
	status: "resolved" | "none" | "error";
	/** @internal */
	modelProfileId: string | null;
	/** @internal */
	source: ProcessActionModelResolutionSource | null;
	/** @internal */
	error: string | null;
}

/** @internal */
export interface ProcessActionWarmPromptCacheContext {
	/** @internal */
	previousModelProfileId: string;
	/** @internal */
	compatibleModelProfileIds: readonly string[];
	/** @internal */
	expiresAt: string;
}

/** @internal */
export interface PromptCacheSwitchResolution {
	/** @internal */
	switchingModelMayBypassPromptCache: boolean;
	/** @internal */
	recommendedModelProfileId: string | null;
}

/** @internal */
export function resolvePromptCacheSwitch(input: {
	/** @internal */
	context: ProcessActionWarmPromptCacheContext | null | undefined;
	/** @internal */
	effectiveModelProfileId: string;
	/** @internal */
	selectableModelProfileIds?: readonly string[];
	/** @internal */
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

/** @internal */
export interface ProcessActionModelPreview {
	/** @internal */
	kind: "llm_turn" | "not_applicable" | "unavailable";
	/** @internal */
	turnId: string | null;
	/** @internal */
	description: string | null;
	/** @internal */
	resolvedModel?: ProcessActionModelResolutionPreview;
	/** @internal */
	warmPromptCache?: ProcessActionWarmPromptCacheContext;
	/** @internal */
	unavailableReason?:
		| "action_not_found"
		| "action_not_visible"
		| "invalid_action_input"
		| "action_failed";
	/** @internal */
	unavailableMessage?: string | null;
}

/** @internal */
export type ProcessExternalSourceSummary = {
	/** @internal */
	id: string;
	/** @internal */
	kind: string;
	/** @internal */
	externalActionId?: string;
	/** @internal */
	sourceKind?: string;
	/** @internal */
	label: string | null;
	/** @internal */
	description: string | null;
};

/** @internal */
export type ProcessExternalTriggerSummary = ProcessExternalSourceSummary;

/** @internal */
export interface ProcessSelectedTurnSummary {
	/** @internal */
	turnId: string;
	/** @internal */
	kind: ProcessTurnType;
	/** @internal */
	description: string;
	/** @internal */
	commentary: string | null;
	/** @internal */
	externalTriggers: ProcessExternalSourceSummary[];
}

/** @internal */
export type ModelProfileAvailability = "available" | "unavailable" | "stale";

/** @internal */
export type ModelProfileOptionSummary = {
	/** @internal */
	id: string;
	/** @internal */
	label: string;
	/** @internal */
	description: string;
	/** @internal */
	availability: ModelProfileAvailability;
	/** @internal */
	safeReason?: string | null;
	/** @internal */
	checkedAt?: string | null;
};

/** @internal */
export interface ProviderOptionChoiceSummary {
	/** @internal */
	value: string;
	/** @internal */
	label: string;
}

/** @internal */
export interface ProviderOptionFieldSummary {
	/** @internal */
	id: string;
	/** @internal */
	label: string;
	/** @internal */
	required: boolean;
	/** @internal */
	minLength: number | null;
	/** @internal */
	maxLength: number | null;
	/** @internal */
	defaultValue: string | null;
	/** Advisory values. Values outside this list can still be valid. */
	/** @internal */
	choices: readonly ProviderOptionChoiceSummary[];
}

/** @internal */
export interface ModelProviderOptionsResponseBody {
	/** @internal */
	modelProfileId: string;
	/** @internal */
	providerId: string;
	/** @internal */
	fields: readonly ProviderOptionFieldSummary[];
	/** @internal */
	choicesStatus: "available" | "unavailable";
	/** @internal */
	choicesUnavailableReason: string | null;
}

/** @internal */
export interface ProcessTurnModelConfigurationView {
	/** @internal */
	turnId: string;
	/** @internal */
	description: string;
	/** @internal */
	pathType: string;
	/** @internal */
	processConfigModelProfileId: string | null;
	/** @internal */
	instanceModelProfileId: string | null;
	/** @internal */
	effectiveConfiguredModelProfileId: string | null;
	/** @internal */
	source: "instance" | "process_config" | "default";
}

/** @internal */
export type ProcessModelConfigurationIssueView = {
	/** @internal */
	code: "invalid_turn_configs_json";
	/** @internal */
	reason: "invalid_json" | "not_object" | "turn_config_not_object";
	/** @internal */
	turnId?: string;
};

/** @internal */
export interface ProcessModelConfigurationView {
	/** @internal */
	state:
		| {
				/** @internal */
				kind: "ready";
		  }
		| {
				/** @internal */
				kind: "blocked";
				/** @internal */
				issues: readonly ProcessModelConfigurationIssueView[];
		  };
	/** @internal */
	availableProfiles: readonly ModelProfileOptionSummary[];
	/** @internal */
	effectiveSelectedTurn: {
		/** @internal */
		turnId: string;
		/** @internal */
		description: string;
		/** @internal */
		modelProfileId: string;
		/** @internal */
		source: ProcessActionModelResolutionSource;
	} | null;
	/** @internal */
	defaultModel: {
		/** @internal */
		processConfigModelProfileId: string | null;
		/** @internal */
		instanceModelProfileId: string | null;
		/** @internal */
		effectiveModelProfileId: string | null;
		/** @internal */
		source: "instance" | "process_config" | "catalog_default" | "none";
	};
	/** @internal */
	turns: readonly ProcessTurnModelConfigurationView[];
}

/** @internal */
export type ProcessRunToolParameterView = {
	/** @internal */
	name: string;
	/** @internal */
	type: string;
	/** @internal */
	description: string;
	/** @internal */
	required: boolean;
};

/** @internal */
export type ProcessRunToolView = {
	/** @internal */
	name: string;
	/** @internal */
	description: string;
	/** @internal */
	parameters: readonly ProcessRunToolParameterView[];
};

/** @internal */
export type ProcessRunTurnView = {
	/** @internal */
	turnId: string;
	/** @internal */
	description: string;
	/** @internal */
	pathType: string;
	/** @internal */
	consumedProducts: readonly string[];
	/** @internal */
	publishedProducts: readonly string[];
	/** @internal */
	activePiToolNames: readonly string[];
	/** @internal */
	outcomeActions: readonly ProcessRunToolView[];
};

/** @internal */
export type ProcessRunDetailsView = {
	/** @internal */
	systemPrompt: string | null;
	/** @internal */
	appendSystemPrompt: string | null;
	/** @internal */
	availablePiToolNames: readonly string[];
	/** @internal */
	turns: readonly ProcessRunTurnView[];
};

/** @internal */
export interface ProcessLaunchConfigurationParameterView {
	/** @internal */
	fieldId: string;
	/** @internal */
	label: string;
	/** @internal */
	value: string | null;
}

/** @internal */
export interface ProcessLaunchConfigurationProjectView {
	/** @internal */
	key: string;
	/** @internal */
	repoLocator: string;
	/** @internal */
	repoLocatorKind: ProcessProject["repoLocatorKind"];
	/** @internal */
	baseBranch: string;
	/** @internal */
	workBranch: string | null;
	/** @internal */
	externalId: string | null;
	/** @internal */
	externalUrl: string | null;
	/** @internal */
	pipelineStatus: string | null;
}

/** @internal */
export interface ProcessLaunchConfigurationView {
	/** @internal */
	launcherId: string | null;
	/** @internal */
	launcherLabel: string | null;
	/** @internal */
	launcherSchemaTitle: string | null;
	/** @internal */
	paramsParseError: string | null;
	/** @internal */
	parameters: readonly ProcessLaunchConfigurationParameterView[];
	/** @internal */
	projects: readonly ProcessLaunchConfigurationProjectView[];
}

/** @internal */
export interface PiSessionUsageSnapshot extends UsageTokenCounts {
	/** @internal */
	cost?: UsageCostSnapshot;
}

/** @internal */
export type PiSessionTextContentBlock = {
	/** @internal */
	type: "text";
	/** @internal */
	text: string;
};

/** @internal */
export type PiSessionThinkingContentBlock = {
	/** @internal */
	type: "thinking";
	/** @internal */
	thinking: string;
	/** @internal */
	redacted?: boolean;
};

/** @internal */
export type PiSessionToolCallContentBlock = {
	/** @internal */
	type: "toolCall";
	/** @internal */
	id: string;
	/** @internal */
	name: string;
	/** @internal */
	arguments: Record<string, unknown>;
};

/** @internal */
export type PiSessionImageContentBlock = {
	/** @internal */
	type: "image";
	/** @internal */
	data: string;
	/** @internal */
	mimeType: string;
};

/** @internal */
export type PiSessionContentBlock =
	| PiSessionTextContentBlock
	| PiSessionThinkingContentBlock
	| PiSessionToolCallContentBlock
	| PiSessionImageContentBlock;

/** @internal */
export interface PiSessionMessageRecord {
	/** @internal */
	role?: string;
	/** @internal */
	content?: string | PiSessionContentBlock[];
	/** @internal */
	toolCallId?: string;
	/** @internal */
	toolName?: string;
	/** @internal */
	details?: unknown;
	/** @internal */
	isError?: boolean;
	/** @internal */
	usage?: PiSessionUsageSnapshot;
	/** @internal */
	stopReason?: string;
	/** @internal */
	errorMessage?: string;
	/** @internal */
	provider?: string;
	/** @internal */
	model?: string;
	/** @internal */
	timestamp?: number;
}

/** @internal */
export interface PiSessionEntry {
	/** @internal */
	type: string;
	/** @internal */
	id: string;
	/** @internal */
	parentId: string | null;
	/** @internal */
	timestamp: string;
	/** @internal */
	message?: PiSessionMessageRecord;
	/** @internal */
	targetId?: string;
	/** @internal */
	label?: string;
}

/** @internal */
export interface ProcessDiagnosticsData {
	/** @internal */
	process: ProcessInstance;
	/** @internal */
	projects: ProcessProject[];
	/** @internal */
	inputs: ProcessInput[];
	/** @internal */
	events: ProcessEvent[];
	/** @internal */
	leafOutcomeSnapshots: ProcessLeafOutcomeSnapshot[];
	/** @internal */
	turnRecords: ProcessTurnRecord[];
	/** @internal */
	turnAnnotations: ProcessTurnAnnotation[];
	/** @internal */
	workerLease: WorkerLease | null;
	/** @internal */
	processDisplayName: string | null;
	/** @internal */
	processGraph: SerializedProcessGraph;
	/** @internal */
	processFlow: ProcessFlowView;
	/** @internal */
	piSessionEntries: PiSessionEntry[];
	/** @internal */
	definesLeafOutcome: boolean;
	/** @internal */
	selectedTurn?: ProcessSelectedTurnSummary | null;
	/** @internal */
	scheduledAction?: ScheduledActionDetail | null;
	/** @internal */
	modelConfiguration: ProcessModelConfigurationView;
	/** @internal */
	runDetails: ProcessRunDetailsView;
	/** @internal */
	launchConfiguration: ProcessLaunchConfigurationView;
	/** @internal */
	actions: ProcessActionSummary[];
	/** @internal */
	toolRenderers: ToolCallRendererDefinition[];
}

/** @internal */
export interface ProcessDetailData extends ProcessDiagnosticsData {
	/** @internal */
	primaryPath: PrimaryPathSnapshot;
}

/** @internal */
export interface LauncherModelConfigSchema {
	/** @internal */
	availableProfiles: readonly ModelProfileOptionSummary[];
	/** @internal */
	llmTurns: ReadonlyArray<{
		/** @internal */
		turnId: string;
		/** @internal */
		description: string;
	}>;
}

/** @internal */
export type LauncherDefaultModelPreview = {
	/** @internal */
	source: "instance_default" | "process_config_default" | "catalog_default" | "none";
	/** @internal */
	profile: ModelProfileOptionSummary | null;
};

/** @internal */
export interface LauncherTurnModelConfigPreview {
	/** @internal */
	turnId: string;
	/** @internal */
	description: string;
	/** @internal */
	effective: {
		/** @internal */
		source: ProcessActionModelResolutionSource;
		/** @internal */
		profile: ModelProfileOptionSummary | null;
	};
}

/** @internal */
export type LauncherModelConfigPreview = {
	/** @internal */
	defaultModel: LauncherDefaultModelPreview;
	/** @internal */
	turns: readonly LauncherTurnModelConfigPreview[];
};

/** @internal */
export type UiLauncherSummary = UiLauncherSummaryBase & {
	/** @internal */
	modelConfigSchema?: LauncherModelConfigSchema;
	/** @internal */
	processFlow?: ProcessFlowView;
};

/** @internal */
export type ProcessRetryConfig = {
	/** @internal */
	launcherId: string;
	/** @internal */
	title: string | null;
	/** @internal */
	launcherInput: Record<string, unknown>;
	/** @internal */
	skillIds: string[];
	/** @internal */
	modelConfig: LauncherModelConfigDefaults;
};

/** @internal */
export type WatcherLaunchModelSummary = {
	/** @internal */
	defaultModelProfileId: string | null;
	/** @internal */
	turnConfigs: Array<{
		/** @internal */
		turnId: string;
		/** @internal */
		modelProfileId: string | null;
	}>;
};

/** @public */
export interface WatcherPresentationField {
	/** @public */
	label: string;
	/** @public */
	value: string;
	/** @internal */
	format?: "text" | "code";
}

/** @internal */
export interface WatcherSummary {
	/** @internal */
	processId: string;
	/** @internal */
	processDisplayName: string;
	/** @internal */
	watcherId: string;
	/** @internal */
	label: string;
	/** @internal */
	description: string;
	/** @internal */
	sourceId: string;
	/** @internal */
	sourceLabel: string;
	/** @internal */
	enabled: boolean;
	/** @internal */
	configPath: string;
	/** @internal */
	targetSummary: string;
	/** @internal */
	details: WatcherPresentationField[];
	/** @internal */
	launchModel: WatcherLaunchModelSummary;
}

/** @internal */
export interface SkillUsageSummary {
	/** @internal */
	attachedAllTime: number;
	/** @internal */
	attachedLast30Days: number;
	/** @internal */
	invokedAllTime: number;
	/** @internal */
	invokedLast30Days: number;
}

/** @internal */
export interface SkillRepositorySummary {
	/** @internal */
	id: string;
	/** @internal */
	label: string;
	/** @internal */
	url: string;
	/** @internal */
	ref: string;
	/** @internal */
	path: string;
	/** @internal */
	lastRefreshedAt: string | null;
	/** @internal */
	error: string | null;
}

/** @internal */
export interface SkillCatalogItem {
	/** @internal */
	repositoryId: string;
	/** @internal */
	id: string;
	/** @internal */
	label: string;
	/** @internal */
	description: string | null;
	/** @internal */
	sourcePath: string;
	/** @internal */
	sourceRevision: string;
	/** @internal */
	registered: boolean;
	/** @internal */
	updateAvailable: boolean;
	/** @internal */
	conflict: boolean;
	/** @internal */
	stale: boolean;
	/** @internal */
	modelInvocable: boolean;
	/** @internal */
	usage: SkillUsageSummary;
}

/** @internal */
export type SkillRegistrationKind = "configuration" | "catalog";

/** @internal */
export interface InstalledSkillCatalogItem {
	/** @internal */
	id: string;
	/** @internal */
	label: string;
	/** @internal */
	description: string | null;
	/** @internal */
	activeRevisionId: string;
	/** @internal */
	activeSourceRevision: string | null;
	/** @internal */
	registrationKind: SkillRegistrationKind;
	/** @internal */
	sourceRepositoryId: string | null;
	/** @internal */
	updateAvailable: boolean;
	/** @internal */
	modelInvocable: boolean;
	/** @internal */
	usage: SkillUsageSummary;
}

/** @internal */
export interface SkillRevisionSummary {
	/** @internal */
	id: string;
	/** @internal */
	sourceRevision: string | null;
	/** @internal */
	importedAt: string;
	/** @internal */
	active: boolean;
}

/** @internal */
export interface SkillUsageProcessSummary {
	/** @internal */
	instanceId: string;
	/** @internal */
	title: string;
	/** @internal */
	attachedAt: string;
	/** @internal */
	invocationCount: number;
	/** @internal */
	lastInvokedAt: string | null;
}

/** @internal */
export interface SkillCatalogDetail extends SkillCatalogItem {
	/** @internal */
	skillMarkdown: string;
	/** @internal */
	processes: SkillUsageProcessSummary[];
}

/** @internal */
export interface InstalledSkillCatalogDetail extends InstalledSkillCatalogItem {
	/** @internal */
	skillMarkdown: string;
	/** @internal */
	processes: SkillUsageProcessSummary[];
	/** @internal */
	revisions: SkillRevisionSummary[];
}

/** @internal */
export type ErrorResponseBody = {
	/** @internal */
	error?: string | null;
	/** @internal */
	code?: string | null;
};

/** @internal */
export type ProcessesListResponseBody = {
	/** @internal */
	processes: ProcessListItem[];
	/** @internal */
	futureExecutions: FutureExecutionSummary[];
};

/** @internal */
export interface ProcessOverviewItem extends ProcessRowSlot {
	/** @internal */
	processDisplayName: string | null;
	/** Nullable durable title before external-id/instance-id display fallback. */
	/** @internal */
	processTitle: string | null;
	/** @internal */
	initialPromptPreview: string | null;
	/** @internal */
	createdAt: string;
	/** @internal */
	updatedAt: string;
	/** @internal */
	closedAt: string | null;
}

/** @internal */
interface FutureExecutionOverviewItemBase
	extends Omit<FutureExecutionBaseSummary, "kind" | "subtitle" | "modelSelection"> {
	/** @internal */
	initialPromptPreview: string | null;
}

/** @internal */
export interface FutureLaunchOverviewItem extends FutureExecutionOverviewItemBase {
	/** @internal */
	kind: "launch";
	/** @internal */
	instanceId: null;
	/** @internal */
	launcherId: string;
	/** @internal */
	launcherLabel: string;
}

/** @internal */
export interface FutureActionOverviewItem extends FutureExecutionOverviewItemBase {
	/** @internal */
	kind: "action";
	/** @internal */
	instanceId: string;
	/** @internal */
	actionId: string;
	/** @internal */
	actionLabel: string;
}

/** @internal */
export type FutureExecutionOverviewItem = FutureLaunchOverviewItem | FutureActionOverviewItem;

/** @internal */
export interface ProcessesOverviewResponseBody {
	/** @internal */
	processes: ProcessOverviewItem[];
	/** @internal */
	futureExecutions: FutureExecutionOverviewItem[];
	/** True when the bounded sidebar response omitted less-recent rows. */
	/** @internal */
	truncated: boolean;
}

/** @internal */
export interface ProcessBrowsePagination {
	/** @internal */
	limit: number;
	/** @internal */
	offset: number;
	/** @internal */
	total: number;
	/** @internal */
	processTotal: number;
	/** @internal */
	futureExecutionTotal: number;
	/** @internal */
	hasMore: boolean;
}

/** @internal */
export interface ProcessBrowseFacets {
	/** @internal */
	statusCounts: Record<
		"all" | "running" | "scheduled" | "needs_attention" | "completed" | "aborted",
		number
	>;
	/** @internal */
	processTypes: Array<{
		/** @internal */
		value: string;
		/** @internal */
		label: string;
		/** @internal */
		count: number;
	}>;
}

/** @internal */
export type ProcessBrowseItem =
	| {
			/** @internal */
			kind: "process";
			/** @internal */
			item: ProcessOverviewItem;
	  }
	| {
			/** @internal */
			kind: "future";
			/** @internal */
			item: FutureExecutionOverviewItem;
	  };

/** @internal */
export interface ProcessBrowseResponseBody {
	/** Globally sorted page. The browser must preserve this server-owned order. */
	/** @internal */
	items: ProcessBrowseItem[];
	/** @internal */
	pagination: ProcessBrowsePagination;
	/** @internal */
	facets: ProcessBrowseFacets;
}

/** @internal */
export type TurnTraceToolCallSnapshot = Omit<PrimaryPathToolCallSnapshot, "result"> & {
	/** @internal */
	resultText: string | null;
	/** @internal */
	truncated: boolean;
};

/** @internal */
export type TurnPiInputPartRole = "user" | "system" | "unknown";

/** @internal */
export interface TurnPiInputPart {
	/** @internal */
	role: TurnPiInputPartRole;
	/** @internal */
	text: string;
	/** @internal */
	createdAt: string;
}

/** @internal */
export interface TurnPiInputSnapshot {
	/** @internal */
	parts: TurnPiInputPart[];
	/** @internal */
	fullPrompt: string;
	/** @internal */
	createdAt: string;
	/** @internal */
	userInput?: string | null;
}

/** @internal */
export interface TurnTraceSnapshot {
	/** @internal */
	assistant: PrimaryPathStreamingAssistantSnapshot;
	/** @internal */
	toolCalls: TurnTraceToolCallSnapshot[];
	/** @internal */
	traceItems: PrimaryPathTraceItemSnapshot[];
	/** @internal */
	usage: TurnUsageSnapshot | null;
	/** @internal */
	piInput: TurnPiInputSnapshot | null;
}

/** @internal */
export interface TurnTracePreview {
	/** @internal */
	turnRecordId: string;
	/** @internal */
	assistantTextPreview: string;
	/** @internal */
	assistantTextTruncated: boolean;
	/** @internal */
	thinkingPreview: string;
	/** @internal */
	thinkingPreviewTruncated: boolean;
	/** @internal */
	toolCallCount: number;
	/** @internal */
	traceItemCount: number;
	/** @internal */
	hasReasoningDetails: boolean;
	/** @internal */
	usage: TurnUsageSnapshot | null;
	/** @internal */
	piInput: {
		/** @internal */
		createdAt: string | null;
		/** @internal */
		partCount: number;
		/** @internal */
		userInputPreview: string | null;
	} | null;
}

/** @internal */
export type ProcessTimelineTurnPresentation =
	| "llm_turn"
	| "automatic_turn"
	| "operator_decision"
	| "external_trigger";

/** @internal */
export interface ProcessTimelineTurnSummary {
	/** @internal */
	id: string;
	/** @internal */
	turnId: string;
	/** @internal */
	turnType: ProcessTurnType;
	/** @internal */
	displayTurn: string;
	/** @internal */
	outcome: string;
	/** @internal */
	summary: string;
	/** @internal */
	output: string;
	/** @internal */
	turnResultMarkdown: string;
	/** @internal */
	resultSummary?: string;
	/** @internal */
	reviewedTurnRecordId?: string;
	/** @internal */
	resources?: import("@leitwerk-dev/domain").TurnProgressLink[];
	/** @internal */
	transition?: {
		/** @internal */
		selectedTurnId: string;
		/** @internal */
		targetTurnRecordId?: string;
		/** @internal */
		accepted: boolean;
	};
	/** @internal */
	pathType: ProcessTurnRecord["pathType"];
	/** @internal */
	createdAt: string;
	/** @internal */
	presentation: ProcessTimelineTurnPresentation;
	/** @internal */
	status: "completed" | "in_progress";
	/** @internal */
	modelProfileId: string | null;
	/** Durable lineage needed by the chronicle rail and input correlation. */
	/** @internal */
	attemptNumber: number;
	/** @internal */
	parentTurnRecordId: string | null;
	/** @internal */
	startedAt: string;
	/** @internal */
	endedAt: string | null;
	/** @internal */
	actionSource: "ui" | "external" | "scheduled" | null;
	/** @internal */
	progress?: TurnProgressReport | null;
	/** @internal */
	progressRecordedAt?: string;
}

/** @internal */
export type ProcessTimelineInputSummary = Pick<
	ProcessInput,
	"id" | "sequence" | "source" | "kind" | "bodyMarkdown" | "receivedAt" | "consumedAt"
>;

/** @internal */
export interface ProcessExternalObservation {
	/** @internal */
	summary: string;
	/** @internal */
	links?: import("@leitwerk-dev/domain").TurnProgressLink[];
	/** @internal */
	observedAt: string;
	/** @internal */
	subject: string;
	/** @internal */
	revision: string;
}

/** @internal */
export interface ProcessExternalTriggerSignal {
	/** @internal */
	observation?: ProcessExternalObservation;
	/** @internal */
	refreshError?: string | null;
	/** @internal */
	refreshedAt?: string;
	/** @internal */
	triggerId: string;
	/** @internal */
	state: "error" | "armed" | "triggered" | "waiting";
	/** @internal */
	occurredAt: string | null;
	/** @internal */
	secondaryDetail: string | null;
}

/** @internal */
export interface ProcessTimelineSnapshot {
	/** @internal */
	prompt: {
		/** @internal */
		text: string | null;
		/** @internal */
		createdAt: string | null;
	};
	/** @internal */
	turns: ProcessTimelineTurnSummary[];
	/** @internal */
	tracePreviewsByTurnRecordId: Record<string, TurnTracePreview>;
	/** @internal */
	inputs: ProcessTimelineInputSummary[];
	/** @internal */
	externalTriggerSignals: ProcessExternalTriggerSignal[];
}

/** @internal */
export interface CurrentErrorSummary {
	/** @internal */
	title: string;
	/** @internal */
	summary: string;
	/** @internal */
	guidance?: string;
	/** @internal */
	technicalDetail?: string | null;
}

/** @internal */
export interface CurrentTurnRecoverySummary extends CurrentErrorSummary {
	/** @internal */
	turnRecordId: string;
	/** @internal */
	defaultContinuePrompt: string;
	/** @internal */
	canContinue: boolean;
	/** @internal */
	supportsModelOverride: boolean;
	/** @internal */
	defaultModelProfileId: string | null;
	/** @internal */
	providerOptions: Record<string, string>;
}

/** @internal */
export interface StartupRecoverySummary extends CurrentErrorSummary {
	/** @internal */
	startRecordId: string;
	/** @internal */
	kind: "preparation_failed" | "bootstrap_failed";
	/** @internal */
	action: "choose_model" | "retry_startup";
	/** @internal */
	defaultModelProfileId: string | null;
	/** @internal */
	providerOptions: Record<string, string>;
}

/** @internal */
export type StartupAttemptStatus = "starting" | "failed" | "succeeded" | "recovered" | "superseded";

/** @internal */
export interface StartupAttemptStepSummary {
	/** Observed phase interval; absent for older servers or unavailable evidence. */
	/** @internal */
	startedAt?: string | null;
	/** @internal */
	endedAt?: string | null;
	/** @internal */
	detail?: string;
	/** @internal */
	id: "start_worker" | "connect_worker" | "prepare_workspace" | "start_first_turn";
	/** @internal */
	label: string;
	/** @internal */
	status: "pending" | "in_progress" | "completed" | "failed" | "superseded";
	/** @internal */
	occurredAt: string | null;
}

/** Worker-start history derived from correlated start, lease, readiness, and turn records. */
/** @internal */
export interface StartupAttemptSummary {
	/** @internal */
	startRecordId: string;
	/** @internal */
	workerLeaseId: string | null;
	/** @internal */
	status: StartupAttemptStatus;
	/** @internal */
	startedAt: string;
	/** @internal */
	readyAt: string | null;
	/** @internal */
	durationMs: number | null;
	/** @internal */
	summary: string | null;
	/** @internal */
	recoveredByStartRecordId: string | null;
	/** @internal */
	steps: StartupAttemptStepSummary[];
}

/** @internal */
export interface ProcessStartupSummary {
	/** @internal */
	workerStarts?: import("@leitwerk-dev/domain").PhysicalWorkerStart[];
	/** @internal */
	authoritativeAttemptId: string | null;
	/** @internal */
	attempts: StartupAttemptSummary[];
	/** @internal */
	recovery: StartupRecoverySummary | null;
}

/** @internal */
export type CurrentProcessErrorSummary = CurrentErrorSummary;

/** @internal */
export interface ProcessUsageEstimateSnapshot {
	/** @internal */
	usage: TurnUsageSnapshot;
	/** @internal */
	includesLiveTurn: boolean;
	/** @internal */
	totalLlmTurnCount: number;
	/** @internal */
	coveredTurnCount: number;
	/** @internal */
	missingUsageTurnCount: number;
	/** @internal */
	missingCostTurnCount: number;
	/** @internal */
	isPartial: boolean;
}

/** @internal */
export interface PrimaryPathUiSnapshot extends Omit<PrimaryPathSnapshot, "turnState"> {
	/** @internal */
	throughEventSequence: number;
	/** @internal */
	turnState: Omit<PrimaryPathSnapshot["turnState"], "activeTurn"> & {
		/** @internal */
		activeTurn: CompactActiveTurnSnapshot | null;
	};
	/** @internal */
	entryCount: number;
	/** @internal */
	entriesOmitted: true;
}

/** @internal */
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
/** @internal */
export interface ProcessDetailUiSnapshotResponseBody {
	/** @internal */
	process: ProcessUiSnapshotProcess;
	/** Next turn on the declared happy path, including human decisions. */
	/** @internal */
	plannedNextTurn?: Pick<ProcessSelectedTurnSummary, "turnId" | "description"> | null;
	/** Durable requests in Chronicle order; at most one is open for the current turn. */
	/** @internal */
	questionRequests: ProcessQuestionRequest[];
	/** @internal */
	toolApprovalRequests: ProcessToolApprovalRequest[];
	/** @internal */
	leafOutcomeSnapshots: ProcessLeafOutcomeSnapshot[];
	/** @internal */
	processDisplayName: string | null;
	/** @internal */
	processFlow: ProcessFlowView;
	/** @internal */
	definesLeafOutcome: boolean;
	/** @internal */
	selectedTurn: ProcessSelectedTurnSummary | null;
	/** @internal */
	scheduledAction: ScheduledActionDetail | null;
	/** @internal */
	modelConfiguration: ProcessModelConfigurationView;
	/** @internal */
	runDetails: ProcessRunDetailsView;
	/** @internal */
	launchConfiguration: ProcessLaunchConfigurationView;
	/** @internal */
	actions: ProcessActionSummary[];
	/** @internal */
	toolRenderers: ToolCallRendererDefinition[];
	/** @internal */
	primaryPath: PrimaryPathUiSnapshot;
	/** @internal */
	timeline: ProcessTimelineSnapshot;
	/** @internal */
	instanceTree: ProcessInstanceTreeResponseBody;
	/** @internal */
	recovery: CurrentTurnRecoverySummary | null;
	/** Authoritative startup history and current remediation. */
	/** @internal */
	startup: ProcessStartupSummary;
	/** Compatibility alias for startup.recovery. */
	/** @internal */
	startupRecovery: StartupRecoverySummary | null;
	/** @internal */
	processError: CurrentProcessErrorSummary | null;
	/** @internal */
	usageEstimate: ProcessUsageEstimateSnapshot | null;
	/** @internal */
	persistedModelSelectionWarning: string | null;
	/** @internal */
	session: {
		/** @internal */
		signature: string | null;
	};
	/** @internal */
	sessionTransfer: SessionTransferOperationView | null;
}

/** @internal */
export type InstanceTreeTurnResultState = "succeeded" | "failed" | "aborted" | "pending";

/** Redacted, semantic process history. Pi message/activity categories are never exposed. */
/** @internal */
export interface InstanceTreeNodeSummary {
	/** @internal */
	id: string;
	/** @internal */
	parentId: string | null;
	/** @internal */
	label: string;
	/** @internal */
	pathType: "primary" | "root_branch" | "leaf_branch";
	/** @internal */
	resultState: InstanceTreeTurnResultState;
	/** @internal */
	timestamp: string;
}

/** @internal */
export interface InstanceTreeEdgeSummary {
	/** @internal */
	id: string;
	/** @internal */
	sourceNodeId: string;
	/** @internal */
	targetNodeId: string | null;
	/** @internal */
	hasContext: boolean;
	/** @internal */
	productLabels: readonly string[];
	/** @internal */
	actionLabel: string | null;
	/** @internal */
	endState: "not_applied" | "completed" | null;
}

/** @internal */
export interface ProcessInstanceTreeResponseBody {
	/** @internal */
	currentLeafId: string | null;
	/** @internal */
	nodes: InstanceTreeNodeSummary[];
	/** @internal */
	edges: InstanceTreeEdgeSummary[];
}

/** @internal */
export interface TurnReasoningDetailResponseBody {
	/** @internal */
	state: "live" | "committed";
	/** @internal */
	throughEventSequence: number;
	/** @internal */
	instanceId: string;
	/** @internal */
	turnRecordId: string;
	/** @internal */
	sessionSignature: string | null;
	/** @internal */
	reasoning: TurnTraceSnapshot;
}

/** @internal */
export interface SubmitQuestionAnswersRequestBody {
	/** @internal */
	draft: QuestionAnswerDraft[];
}

/** @internal */
export type QuestionRequestMutationResponseBody = {
	/** @internal */
	request: ProcessQuestionRequest;
};

/** @internal */
export type FutureExecutionDetailResponseBody = FutureExecutionSummary;

/** @internal */
export type LaunchersResponseBody = {
	/** @internal */
	launchers: UiLauncherSummary[];
};

/** @internal */
export type WatchersResponseBody = {
	/** @internal */
	watchers: WatcherSummary[];
};
/** @internal */
export type SkillCatalogDetailResponseBody = {
	/** @internal */
	skill: SkillCatalogDetail;
};
/** @internal */
export type InstalledSkillCatalogDetailResponseBody = {
	/** @internal */
	skill: InstalledSkillCatalogDetail;
};
/** @internal */
export type SkillsCatalogResponseBody = {
	/** @internal */
	repositories: SkillRepositorySummary[];
	/** @internal */
	availableSkills: SkillCatalogItem[];
	/** @internal */
	installedSkills: InstalledSkillCatalogItem[];
};

/** @internal */
export interface LauncherDefaultsResponseBody {
	/** @internal */
	defaults: Record<string, unknown>;
	/** @internal */
	title: string | null;
	/** @internal */
	modelConfig: LauncherModelConfigDefaults;
	/** @internal */
	warnings?: LauncherValidationError[];
}

/** @internal */
export type LauncherOptionsResponseBody = {
	/** @internal */
	options: Record<string, readonly FormFieldOptionDefinition[]>;
};

/** @internal */
export type LauncherRecentValuesResponseBody = {
	/** @internal */
	values: Record<string, readonly string[]>;
};

/** @internal */
export type LauncherModelConfigPreviewResponseBody = {
	/** @internal */
	preview: LauncherModelConfigPreview;
};

/** @internal */
export interface LauncherMutationResponseBody {
	/** @internal */
	kind?: "scheduled";
	/** @internal */
	process?: ProcessInstance | null;
	/** @internal */
	futureExecution?: FutureLaunchSummary | null;
	/** @internal */
	projects?: ProcessProject[];
	/** @internal */
	errors?: LauncherValidationError[];
	/** @internal */
	error?: string | null;
}

/** @internal */
export interface FutureLaunchMutationResponseBody {
	/** @internal */
	kind: "scheduled";
	/** @internal */
	futureExecution: FutureLaunchSummary | null;
	/** @internal */
	error?: string | null;
}

/** @internal */
export type ScheduledActionMutationResponseBody = {
	/** @internal */
	kind?: "scheduled";
	/** @internal */
	scheduledAction?: ScheduledActionDetail | null;
	/** @internal */
	error?: string | null;
};

/** @internal */
export type ProcessRetryConfigResponseBody = ProcessRetryConfig;

/** @internal */
export type ProcessActionModelPreviewResponseBody = {
	/** @internal */
	preview: ProcessActionModelPreview;
};

/** @internal */
export type ProcessDiagnosticsResponseBody = ProcessDiagnosticsData;

/** @internal */
export type PrimaryPathSnapshotResponseBody = PrimaryPathSnapshot;

/** @internal */
export type CronPreviewResponseBody = {
	/** @internal */
	nextRunAt: string;
};

/** @internal */
export type ParsedLauncherRequestBody = {
	/** @internal */
	title: string | null;
	/** @internal */
	titleProvided: boolean;
	/** @internal */
	launcherInput: Record<string, unknown>;
	/** @internal */
	launcherInputProvided: boolean;
	/** @internal */
	skillIds?: string[];
	/** @internal */
	modelConfig: LauncherModelConfigDefaults;
	/** @internal */
	modelConfigProvided: boolean;
	/** @internal */
	schedule: ParsedScheduleRequest;
	/** @internal */
	scheduleProvided: boolean;
};

/** @internal */
export type ParsedActionRequestBody = {
	/** @internal */
	input: Record<string, unknown>;
	/** @internal */
	inputProvided: boolean;
	/** @internal */
	nextTurnModelProfileId?: string | null;
	/** @internal */
	nextTurnModelProfileIdProvided: boolean;
	/** @internal */
	schedule: ParsedScheduleRequest;
	/** @internal */
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
	/** @internal */
	launcherInput: v.optional(v.nullable(unknownRecordSchema)),
	/** @internal */
	modelConfig: v.optional(v.unknown()),
	/** @internal */
	actor: v.optional(v.nullable(unknownRecordSchema)),
	/** @internal */
	launchPlan: v.object({
		/** @internal */
		launcherId: v.string(),
		/** @internal */
		processId: v.string(),
		/** @internal */
		handoffDedupKey: optionalNullableStringSchema,
		/** @internal */
		processInput: v.object({
			/** @internal */
			processId: v.string(),
			/** @internal */
			selectedTurnId: optionalNullableStringSchema,
			/** @internal */
			lifecycleStatus: v.picklist(PROCESS_LIFECYCLE_STATUSES),
			/** @internal */
			title: optionalNullableStringSchema,
			/** @internal */
			externalId: optionalNullableStringSchema,
			/** @internal */
			externalUrl: optionalNullableStringSchema,
			/** @internal */
			metadata: v.optional(v.nullable(unknownRecordSchema)),
			/** @internal */
			defaultModelProfileId: optionalNullableStringSchema,
			/** @internal */
			turnConfigsJson: optionalNullableStringSchema,
			/** @internal */
			selectedTurnModelProfileId: optionalNullableStringSchema,
			/** @internal */
			selectedTurnModelKind: v.optional(v.nullable(v.picklist(["explicit", "inherited"]))),
			/** @internal */
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
			/** @internal */
			paramsJson: optionalNullableStringSchema,
			/** @internal */
			stateJson: optionalNullableStringSchema,
		}),
		/** @internal */
		titleSourceFields: v.optional(
			v.nullable(
				v.array(
					v.object({
						/** @internal */
						label: v.string(),
						/** @internal */
						value: v.string(),
					}),
				),
			),
		),
		/** @internal */
		projectInputs: v.optional(
			v.nullable(
				v.array(
					v.object({
						/** @internal */
						key: v.string(),
						/** @internal */
						repoLocator: v.string(),
						/** @internal */
						baseBranch: v.string(),
						/** @internal */
						workBranch: optionalNullableStringSchema,
						/** @internal */
						externalId: optionalNullableStringSchema,
						/** @internal */
						externalUrl: optionalNullableStringSchema,
						/** @internal */
						metadata: v.optional(v.nullable(unknownRecordSchema)),
					}),
				),
			),
		),
		/** @internal */
		startTurnId: optionalNullableStringSchema,
	}),
	/** @internal */
	selectedSkillIds: v.optional(v.array(v.string())),
	/** @internal */
	resourceSelections: v.optional(
		v.array(
			v.object({
				/** @internal */
				skillId: v.string(),
				/** @internal */
				revisionId: v.string(),
			}),
		),
	),
});
const futureActionPayloadInputSchema = v.object({
	/** @internal */
	input: v.optional(v.nullable(unknownRecordSchema)),
	/** @internal */
	nextTurnModelProfileId: optionalNullableStringSchema,
	/** @internal */
	actionLabel: optionalNullableStringSchema,
	/** @internal */
	actor: v.optional(v.nullable(unknownRecordSchema)),
});

/** @internal */
export type ParsedScheduleRequest =
	| {
			/** @internal */
			mode: "now";
	  }
	| {
			/** @internal */
			mode: "once";
			/** @internal */
			runAt: string;
	  }
	| {
			/** @internal */
			mode: "cron";
			/** @internal */
			cronExpression: string;
	  };
/** @internal */
type ValidatedScheduleRequest =
	| {
			/** @internal */
			mode: "now";
			/** @internal */
			nextRunAt: null;
			/** @internal */
			cronExpression: null;
	  }
	| {
			/** @internal */
			mode: "once";
			/** @internal */
			nextRunAt: string;
			/** @internal */
			cronExpression: null;
	  }
	| {
			/** @internal */
			mode: "cron";
			/** @internal */
			nextRunAt: string;
			/** @internal */
			cronExpression: string;
	  };

type FutureLaunchPayloadBase = v.InferOutput<typeof futureLaunchPayloadInputSchema>;
type FutureActionPayloadBase = v.InferOutput<typeof futureActionPayloadInputSchema>;
const cloneUnknownRecord = (value?: Record<string, unknown> | null) =>
	value ? { ...value } : null;
/** @internal */
const normalizeFutureLaunchPayload = (payload: FutureLaunchPayloadBase) => {
	const modelConfig = normalizeLaunchModelConfigInput(
		(payload.modelConfig ?? {}) as LaunchModelConfigInput,
	);
	return {
		/** @internal */
		launcherInput: cloneUnknownRecord(payload.launcherInput) ?? {},
		/** @internal */
		modelConfig: {
			/** @internal */
			defaultModelProfileId: modelConfig.defaultModelProfileId ?? null,
			/** @internal */
			turnConfigs: { ...modelConfig.turnConfigs },
		},
		/** @internal */
		actor: normalizeActor(payload.actor),
		/** @internal */
		selectedSkillIds: [
			...(payload.selectedSkillIds ??
				payload.resourceSelections?.map(({ skillId }) => skillId) ??
				[]),
		],
		/** @internal */
		resourceSelections: (payload.resourceSelections ?? []).map((selection) => ({ ...selection })),
		/** @internal */
		launchPlan: {
			/** @internal */
			launcherId: payload.launchPlan.launcherId,
			/** @internal */
			processId: payload.launchPlan.processId,
			/** @internal */
			handoffDedupKey: trimToNull(payload.launchPlan.handoffDedupKey) ?? null,
			/** @internal */
			processInput: {
				/** @internal */
				processId: payload.launchPlan.processInput.processId,
				/** @internal */
				selectedTurnId: payload.launchPlan.processInput.selectedTurnId ?? null,
				/** @internal */
				lifecycleStatus: payload.launchPlan.processInput.lifecycleStatus,
				/** @internal */
				title: payload.launchPlan.processInput.title ?? null,
				/** @internal */
				externalId: payload.launchPlan.processInput.externalId ?? null,
				/** @internal */
				externalUrl: payload.launchPlan.processInput.externalUrl ?? null,
				/** @internal */
				metadata: cloneUnknownRecord(payload.launchPlan.processInput.metadata),
				/** @internal */
				defaultModelProfileId: payload.launchPlan.processInput.defaultModelProfileId ?? null,
				/** @internal */
				turnConfigsJson: payload.launchPlan.processInput.turnConfigsJson ?? null,
				/** @internal */
				selectedTurnModelProfileId:
					payload.launchPlan.processInput.selectedTurnModelProfileId ?? null,
				/** @internal */
				selectedTurnModelKind: payload.launchPlan.processInput.selectedTurnModelKind ?? null,
				/** @internal */
				selectedTurnModelSource: payload.launchPlan.processInput.selectedTurnModelSource ?? null,
				/** @internal */
				paramsJson: payload.launchPlan.processInput.paramsJson ?? null,
				/** @internal */
				stateJson: payload.launchPlan.processInput.stateJson ?? null,
			},
			/** @internal */
			titleSourceFields: (payload.launchPlan.titleSourceFields ?? []).map((field) => ({
				...field,
			})),
			/** @internal */
			projectInputs: (payload.launchPlan.projectInputs ?? []).map((project) => ({
				/** @internal */
				key: project.key,
				/** @internal */
				repoLocator: project.repoLocator,
				/** @internal */
				baseBranch: project.baseBranch,
				/** @internal */
				workBranch: project.workBranch ?? null,
				/** @internal */
				externalId: project.externalId ?? null,
				/** @internal */
				externalUrl: project.externalUrl ?? null,
				/** @internal */
				metadata: cloneUnknownRecord(project.metadata),
			})),
			/** @internal */
			startTurnId: payload.launchPlan.startTurnId ?? null,
		},
	};
};
/** @internal */
const normalizeFutureActionPayload = (payload: FutureActionPayloadBase) => ({
	/** @internal */
	input: cloneUnknownRecord(payload.input) ?? {},
	/** @internal */
	nextTurnModelProfileId: trimToNull(payload.nextTurnModelProfileId) ?? null,
	/** @internal */
	actionLabel: trimToNull(payload.actionLabel) ?? null,
	/** @internal */
	actor: normalizeActor(payload.actor),
});

/** @internal */
export type FutureLaunchPayload = ReturnType<typeof normalizeFutureLaunchPayload>;
/** @internal */
export type FutureActionPayload = ReturnType<typeof normalizeFutureActionPayload>;

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

/** @internal */
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

/** @internal */
export function validateScheduleRequestInput(
	schedule: ParsedScheduleRequest,
	allowedModes: readonly ScheduleMode[],
	options: {
		/** @internal */
		now?: () => Date;
		/** @internal */
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

/** @internal */
export function parseLauncherTurnConfigsJson(
	turnConfigsJson: string | null | undefined,
): ParseResult<InstanceTurnConfigMap> {
	if (!turnConfigsJson) {
		return ok({});
	}
	const parsed = parseJsonPayload(turnConfigsJson, "turnConfigsJson");
	return parsed.ok ? parseLauncherTurnConfigMap(parsed.value, "turnConfigsJson") : parsed;
}

/** @internal */
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

/** @internal */
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
		Object.hasOwn(record.value, "defaultModelProfileId") &&
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
	return (
		Object.hasOwn(object, "mode") ||
		Object.hasOwn(object, "runAt") ||
		Object.hasOwn(object, "cronExpression")
	);
}

/** @internal */
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
		Object.hasOwn(record.value, "title") ||
		record.value.launcherInput !== undefined ||
		record.value.skillIds !== undefined ||
		record.value.modelConfig !== undefined ||
		record.value.schedule !== undefined
	) {
		if (
			Object.keys(record.value).some(
				(key) => !Object.hasOwn(launcherStructuredBodySchema.entries, key),
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
			titleProvided: Object.hasOwn(record.value, "title"),
			launcherInput: parsed.value.launcherInput ?? {},
			launcherInputProvided: Object.hasOwn(record.value, "launcherInput"),
			...(Object.hasOwn(record.value, "skillIds") ? { skillIds: [...skillIds] } : {}),
			modelConfig: modelConfig.value,
			modelConfigProvided: Object.hasOwn(record.value, "modelConfig"),
			schedule: schedule.value,
			scheduleProvided: Object.hasOwn(record.value, "schedule"),
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

/** @internal */
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
	const nextTurnModelProfileIdProvided = Object.hasOwn(record.value, "nextTurnModelProfileId");
	if (
		record.value.input !== undefined ||
		nextTurnModelProfileIdProvided ||
		record.value.schedule !== undefined
	) {
		if (
			Object.keys(record.value).some(
				(key) => !Object.hasOwn(actionStructuredBodySchema.entries, key),
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
			inputProvided: Object.hasOwn(record.value, "input"),
			nextTurnModelProfileIdProvided,
			schedule: schedule.value,
			scheduleProvided: Object.hasOwn(record.value, "schedule"),
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
	});
}

/** @internal */
export function serializeFutureLaunchPayload(payload: unknown): string {
	return JSON.stringify(normalizeFutureLaunchPayload(payload as FutureLaunchPayloadBase));
}

/** @internal */
export function parseFutureLaunchPayloadObject(
	value: unknown,
	context = "Scheduled launch payload",
): ParseResult<FutureLaunchPayload> {
	const parsed = parseSchema(futureLaunchPayloadInputSchema, value, context);
	return parsed.ok ? ok(normalizeFutureLaunchPayload(parsed.value)) : parsed;
}

/** @internal */
export function parseFutureLaunchPayloadJson(
	payloadJson: string,
): ParseResult<FutureLaunchPayload> {
	const parsed = parseJsonPayload(payloadJson, "Scheduled launch payload");
	return parsed.ok ? parseFutureLaunchPayloadObject(parsed.value) : parsed;
}

/** @internal */
export function serializeFutureActionPayload(payload: unknown): string {
	return JSON.stringify(normalizeFutureActionPayload(payload as FutureActionPayloadBase));
}

/** @internal */
export function parseFutureActionPayloadObject(
	value: unknown,
	context = "Scheduled action payload",
): ParseResult<FutureActionPayload> {
	const parsed = parseSchema(futureActionPayloadInputSchema, value, context);
	return parsed.ok ? ok(normalizeFutureActionPayload(parsed.value)) : parsed;
}

/** @internal */
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
