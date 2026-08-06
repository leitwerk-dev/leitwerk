import type {
	Actor,
	InputKind,
	InputSource,
	LaunchModelConfigInput,
	ProcessEvent,
	ProcessInputTarget,
	ProcessInstance,
	ProcessLifecycleStatus,
	ProcessProject,
	TurnId,
	WorkerErrorClass,
} from "@leitwerk-dev/domain";
import type {
	KnownDurableWsFrameType,
	KnownEphemeralWsFrameType,
	LauncherModelConfigPreview,
	LauncherModelConfigSchema,
	ProcessActionModelPreview,
	ProcessWatcherType,
	WsPayloadByType,
} from "@leitwerk-dev/protocol";
import { createCapabilityToken } from "./capabilities.js";
import type {
	ExternalActionSource,
	FormDefinition,
	LauncherContext,
	ProcessLaunchConfig,
	ProcessLauncherService,
	ProcessLaunchPlan,
	RepositoryCredentialRegistrar,
} from "./extension-api.js";

export interface ProcessCreateInputLike {
	processId?: ProcessInstance["processId"];
	selectedTurnId?: ProcessInstance["selectedTurnId"];
	lifecycleStatus?: ProcessInstance["lifecycleStatus"];
	title?: string | null;
	externalId?: string | null;
	externalUrl?: string | null;
	metadata?: Record<string, unknown> | null;
	defaultModelProfileId?: string | null;
	turnConfigsJson?: string | null;
	selectedTurnModelProfileId?: string | null;
	paramsJson?: string | null;
	stateJson?: string | null;
}

export interface ProcessRepoLike {
	create(input: ProcessCreateInputLike): ProcessInstance;
	getById(id: string): ProcessInstance | null;
	listAll(): ProcessInstance[];
}

export interface ProcessProjectRepoLike {
	/** Server-provided project mutation service. Implementations should emit project.updated after committed writes. */
	create(input: {
		instanceId: string;
		key: string;
		repoLocator: string;
		baseBranch: string;
		workBranch?: string | null;
		externalId?: string | null;
		externalUrl?: string | null;
		metadata?: Record<string, unknown> | null;
		pipelineStatus?: string | null;
	}): ProcessProject;
	getByInstanceAndKey(instanceId: string, key: string): ProcessProject | null;
	update(
		id: string,
		input: {
			baseBranch?: string;
			workBranch?: string | null;
			externalId?: string | null;
			externalUrl?: string | null;
			metadata?: Record<string, unknown> | null;
			pipelineStatus?: string | null;
		},
	): ProcessProject | null;
	listByInstance(instanceId: string): ProcessProject[];
}

export interface ProcessEventRepoLike {
	create(input: { instanceId: string; eventType: string; data?: Record<string, unknown> }): unknown;
	listByInstance(instanceId: string, limit?: number): ProcessEvent[];
}

export interface BroadcasterLike {
	sendDurable<T extends KnownDurableWsFrameType>(
		type: T,
		payload: WsPayloadByType[T],
		instanceId?: string,
	): void;
	sendEphemeral?<T extends KnownEphemeralWsFrameType>(
		type: T,
		payload: WsPayloadByType[T],
		instanceId?: string,
	): void;
}

export type LaunchModelConfigInputLike = LaunchModelConfigInput;
export type LauncherModelConfigSchemaLike = LauncherModelConfigSchema;
export type LauncherModelConfigPreviewLike = LauncherModelConfigPreview;

export interface LauncherModelConfigServiceLike {
	getSchema(launcherId: string): Promise<LauncherModelConfigSchemaLike | null>;
	preview(
		launcherId: string,
		launcherInput: Record<string, unknown>,
		opts?: { modelConfig?: LaunchModelConfigInputLike },
	): Promise<LauncherModelConfigPreviewLike | null>;
}

/** Stable, machine-readable codes returned while preparing a launch. */
export type LaunchPlanPreparationIssueCode =
	| "process_id_mismatch"
	| "invalid_turn_configs_json"
	| "unknown_model_profile"
	| "model_profile_not_allowed"
	| "unknown_llm_turn"
	| "selected_turn_model_requires_selected_turn"
	| "selected_turn_model_requires_llm_turn"
	| "model_required";

/** Complete, presentation-safe diagnostic returned while preparing a launch. */
export interface LaunchPlanPreparationIssue {
	readonly code: LaunchPlanPreparationIssueCode;
	readonly message: string;
}

export type LaunchPlanPreparationResultLike =
	| {
			ok: true;
			launchPlan: ProcessLaunchPlan;
			modelConfig: LaunchModelConfigInputLike;
			warnings: readonly LaunchPlanPreparationIssue[];
	  }
	| {
			ok: false;
			/** Normalized durable plan retained when a scheduled launch is blocked. */
			launchPlan: ProcessLaunchPlan;
			modelConfig: LaunchModelConfigInputLike;
			errors: readonly LaunchPlanPreparationIssue[];
	  };

export interface ProcessLaunchPlanServiceLike {
	prepare(
		launchPlan: ProcessLaunchPlan,
		opts?: {
			modelConfig?: LaunchModelConfigInputLike;
			replaceModelConfig?: boolean;
			invalidModelConfig?: "reject" | "omit";
		},
	): Promise<LaunchPlanPreparationResultLike>;
}

export interface HandoffDedupKeyRecordLike {
	key: string;
	instanceId: string;
	createdAt: string;
	metadata: Record<string, unknown>;
}

export interface HandoffDedupKeyServiceLike {
	getByKey(key: string): HandoffDedupKeyRecordLike | null;
}

export interface WorkerSupervisorLike {
	spawnWorker(instanceId: string): Promise<unknown>;
	getWorker(instanceId: string): unknown | undefined;
}

export interface ProcessEngineResultLike {
	ok: boolean;
	code?: string;
	message?: string;
	process?: ProcessInstance | null;
	stage?: "pre_commit" | "post_commit";
	data?: unknown;
}

export interface DeferredProcessActivationExpected {
	processId: string;
	lifecycleStatus: ProcessLifecycleStatus;
	selectedTurnId: TurnId | null;
	title: string | null;
	paramsJson: string | null;
	projectId: string;
	projectKey: string;
	repoLocator: string;
	baseBranch: string;
	workBranch: string | null;
}

export interface DeferredProcessActivationSnapshot extends DeferredProcessActivationExpected {
	instanceId: string;
	processMetadata: Record<string, unknown> | null;
	projectMetadata: Record<string, unknown> | null;
}

export interface DeferredProcessActivationSnapshotQuery {
	projectKey: string;
	instanceId?: string;
	processId?: string;
}

export type DeferredProcessActivationSnapshotResult =
	| { outcome: "ready"; snapshots: DeferredProcessActivationSnapshot[] }
	| { outcome: "process_not_found" }
	| { outcome: "project_not_found" };

export interface DeferredProcessActivationEvent {
	eventType: string;
	data?: Record<string, unknown>;
	level: "info" | "warn" | "error";
	message: string;
}

export interface PreparedDeferredProcessActivation {
	expected: DeferredProcessActivationExpected;
	workBranch: string;
	paramsJson: string;
	projectMetadata: Record<string, unknown> | null;
	selectedTurnId: TurnId;
	event: DeferredProcessActivationEvent;
	actor?: Actor;
}

export type DeferredProcessActivationOutcome =
	| "activated"
	| "already_activated"
	| "stale"
	| "not_applicable"
	| "project_not_found"
	| "invalid_selected_turn";

export interface DeferredProcessActivationFailure {
	expected: DeferredProcessActivationExpected;
	errorClass: WorkerErrorClass;
	event: DeferredProcessActivationEvent;
}

export type ProcessActionExecutionSource = "ui" | "external" | "scheduled";
export type ProcessActionExecutionOrigin = "web_ui" | "external_interface" | "scheduled";

export interface ProcessActionSummaryLike {
	id: string;
	label: string;
	description?: string | null;
	form?: FormDefinition;
}

export type ActionExecutionFailureStageLike = "pre_commit" | "post_commit";

export type ActionExecutionResultLike =
	| {
			ok: true;
			process: ProcessInstance | null;
			data?: Record<string, unknown>;
			error?: undefined;
			code?: undefined;
			stage?: undefined;
	  }
	| {
			ok: false;
			stage: "pre_commit";
			error: string;
			code?: string;
			process?: undefined;
			data?: undefined;
	  }
	| {
			ok: false;
			stage: "post_commit";
			process: ProcessInstance;
			error: string;
			code?: string;
			data?: Record<string, unknown>;
	  };

export interface ProcessActionServiceLike {
	listVisibleActions(instanceId: string): readonly ProcessActionSummaryLike[];
	executeAction(
		instanceId: string,
		actionId: string,
		input: Record<string, unknown>,
		opts?: {
			source?: ProcessActionExecutionSource;
			origin?: ProcessActionExecutionOrigin;
			nextTurnModelProfileId?: string | null;
			actor?: Actor;
		},
	): Promise<ActionExecutionResultLike>;
}

export interface ExternalSourceArmingLike {
	/** Process-local arming id. Durable arming identity is { instanceId, id }. */
	id: string;
	instanceId: string;
	processId: string;
	turnId: string;
	externalActionId: string;
	source: ExternalActionSource;
	resolved: unknown;
}

export interface ExternalSourceFireInput {
	instanceId: string;
	armingId: string;
	input?: Record<string, unknown>;
	event?: Record<string, unknown>;
	mergeKey?: string | null;
}

export interface ExternalSourceServiceLike {
	listArmed(kind: string): readonly ExternalSourceArmingLike[];
	fire(input: ExternalSourceFireInput): Promise<ActionExecutionResultLike>;
}

export type ProcessLaunchFailureStageLike = "pre_commit" | "post_commit";

export type ProcessLaunchExecutionResultLike =
	| { ok: true; process: ProcessInstance; projects: ProcessProject[]; reused: boolean }
	| {
			ok: false;
			stage: "pre_commit";
			status: number;
			body: Record<string, unknown>;
	  }
	| {
			ok: false;
			stage: "post_commit";
			status: number;
			body: Record<string, unknown>;
			process: ProcessInstance;
			projects: ProcessProject[];
	  };

export interface ProcessLaunchConfigExecutionInput {
	launcherId: string;
	launchConfig: ProcessLaunchConfig;
	handoffDedupKey?: string | null;
}

export interface ProcessLaunchExecutorLike {
	createProcessFromLaunchConfig(
		input: ProcessLaunchConfigExecutionInput,
		opts?: { actor?: Actor },
	): Promise<ProcessLaunchExecutionResultLike>;
	createProcessFromLaunchPlan(
		launchPlan: ProcessLaunchPlan,
		opts?: { actor?: Actor },
	): Promise<ProcessLaunchExecutionResultLike>;
}

export interface LauncherRecentValuesServiceLike {
	list(launcherId: string): Record<string, readonly string[]>;
	record(launcherId: string, launcherInput: Record<string, unknown>): void;
}

export interface QueuedProcessInputLike {
	source: InputSource;
	kind: InputKind;
	bodyMarkdown: string;
	target?: ProcessInputTarget | null;
	actor?: Actor;
}

export interface ProcessEngineLike {
	getDeferredProcessActivationSnapshots(
		query: DeferredProcessActivationSnapshotQuery,
	): DeferredProcessActivationSnapshotResult;
	activateDeferredProcess(
		instanceId: string,
		prepared: PreparedDeferredProcessActivation,
	): Promise<ProcessEngineResultLike & { data?: { outcome: DeferredProcessActivationOutcome } }>;
	parkDeferredProcessActivationFailure(
		instanceId: string,
		failure: DeferredProcessActivationFailure,
	): Promise<
		ProcessEngineResultLike & {
			data?: {
				outcome: "parked" | "stale" | "not_applicable" | "project_not_found";
			};
		}
	>;
	startProcess(instanceId: string, startTurnId: TurnId): Promise<ProcessEngineResultLike>;
	abortProcess(instanceId: string, opts?: { actor?: Actor }): Promise<ProcessEngineResultLike>;
	retryProcess(
		instanceId: string,
		opts?: { nextTurnModelProfileId?: string | null; actor?: Actor },
	): Promise<ProcessEngineResultLike>;
	continueFailedTurn(
		instanceId: string,
		turnRecordId: string,
		options?: { prompt?: string | null; nextTurnModelProfileId?: string | null; actor?: Actor },
	): Promise<ProcessEngineResultLike>;
	queueInputs(
		instanceId: string,
		inputs: readonly QueuedProcessInputLike[],
		opts?: { dispatchErrorMessage?: string; actor?: Actor },
	): Promise<ProcessEngineResultLike>;
}

export interface ComponentConfigLike {
	repo: string;
	default_branch: string;
}

export interface ProcessWatcherConfigLike {
	type: ProcessWatcherType;
	[key: string]: unknown;
}

export interface RegisteredProcessWatcherLike {
	processId: string;
	processDisplayName: string;
	watcherId: string;
	watcherLabel: string;
	watcherDescription: string;
	type: ProcessWatcherType;
	enabled: boolean;
	pollInterval: string;
	configPath: string;
	config: ProcessWatcherConfigLike;
	launchModelConfig: LaunchModelConfigInputLike;
}

export interface ResolvedProcessWatcherStartLike {
	watcher: RegisteredProcessWatcherLike;
	launchPlan: ProcessLaunchPlan;
}

export interface ProcessWatcherServiceLike {
	listAll(): readonly RegisteredProcessWatcherLike[];
	listByType(type: ProcessWatcherType): readonly RegisteredProcessWatcherLike[];
	resolveLaunch(
		processId: string,
		watcherId: string,
		payload: unknown,
		ctx?: LauncherContext,
	): Promise<ResolvedProcessWatcherStartLike | null>;
}

export interface ProcessQuestionServiceLike {
	listOpen(instanceId?: string): readonly import("@leitwerk-dev/domain").ProcessQuestionRequest[];
	submitAnswers(
		instanceId: string,
		requestId: string,
		draft: readonly import("@leitwerk-dev/domain").QuestionAnswerDraft[],
		actor: Actor,
	): Promise<
		| { ok: true; request: import("@leitwerk-dev/domain").ProcessQuestionRequest }
		| {
				ok: false;
				code: "not_found" | "not_current" | "invalid";
				message: string;
				request?: import("@leitwerk-dev/domain").ProcessQuestionRequest;
		  }
	>;
}

export interface CoreServerSetupDeps {
	serverBaseUrl: string;
	processWorkspacesDir?: string;
	components: Record<string, ComponentConfigLike>;
	/** Typed by consuming extensions via watcher-utils ExternalWriteLogRepoLike. */
	externalWrites: unknown;
	processes: ProcessRepoLike;
	projects: ProcessProjectRepoLike;
	events: ProcessEventRepoLike;
	broadcaster: BroadcasterLike;
	commands: ProcessEngineLike;
	processActions: ProcessActionServiceLike;
	externalSources: ExternalSourceServiceLike;
	getSupervisor: () => WorkerSupervisorLike | undefined;
	launcherService: ProcessLauncherService;
	launcherRecentValues: LauncherRecentValuesServiceLike;
	launcherModelConfigs: LauncherModelConfigServiceLike;
	launchPlans: ProcessLaunchPlanServiceLike;
	processLaunches: ProcessLaunchExecutorLike;
	handoffDedupKeys?: HandoffDedupKeyServiceLike;
	processWatchers?: ProcessWatcherServiceLike;
	processModelSelection?: ProcessModelSelectionServiceLike;
	/** Durable active-turn questions for trusted operator-channel extensions. */
	processQuestions?: ProcessQuestionServiceLike;
	/** Registration boundary for secret-backed repository credential extensions. */
	repositoryCredentials: RepositoryCredentialRegistrar;
	/** Server-owned managed result images, available to trusted delivery extensions. */
	resultImages?: {
		get(instanceId: string, turnRecordId: string, imageId: string): Promise<Uint8Array | null>;
	};
}

export type ProcessActionModelPreviewLike = ProcessActionModelPreview;

export type ProcessModelSelectionPreviewFailureCode =
	| "process_not_found"
	| "instance_tree_unavailable";

export type ProcessModelSelectionPreviewResultLike =
	| ProcessActionModelPreviewLike
	| { kind: "operational_failure"; code: ProcessModelSelectionPreviewFailureCode };

export interface ModelProfileOptionSummaryLike {
	id: string;
	label: string;
	description: string;
	availability: "available" | "unavailable" | "stale";
}

export interface ProcessModelSelectionServiceLike {
	listAvailableProfiles(instanceId: string): readonly ModelProfileOptionSummaryLike[] | null;
	preview(
		instanceId: string,
		actionId: string,
		input: Record<string, unknown>,
	): Promise<ProcessModelSelectionPreviewResultLike>;
}

export const coreHostCapabilities = {
	serverSetup: createCapabilityToken<CoreServerSetupDeps>("core:serverSetup"),
	processModelSelection: createCapabilityToken<ProcessModelSelectionServiceLike>(
		"core:processModelSelection",
	),
} as const;
