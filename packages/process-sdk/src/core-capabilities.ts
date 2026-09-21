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
	WsPayloadByType,
} from "@leitwerk-dev/protocol";
import { createCapabilityToken } from "./capabilities.js";
import type {
	ExternalActionSource,
	FormDefinition,
	LauncherContext,
	LaunchPreparationCheck,
	ProcessLaunchConfig,
	ProcessLauncherService,
	ProcessLaunchPlan,
	ProcessWatcherPresentation,
	ProcessWatcherSource,
	RepositoryCredentialRegistrar,
} from "./extension-api.js";

/** @internal */
export interface ProcessCreateInputLike {
	/** @internal */
	processId?: ProcessInstance["processId"];
	/** @internal */
	selectedTurnId?: ProcessInstance["selectedTurnId"];
	/** @internal */
	lifecycleStatus?: ProcessInstance["lifecycleStatus"];
	/** @internal */
	title?: string | null;
	/** @internal */
	externalId?: string | null;
	/** @internal */
	externalUrl?: string | null;
	/** @internal */
	metadata?: Record<string, unknown> | null;
	/** @internal */
	defaultModelProfileId?: string | null;
	/** @internal */
	turnConfigsJson?: string | null;
	/** @internal */
	selectedTurnModelProfileId?: string | null;
	/** @internal */
	paramsJson?: string | null;
	/** @internal */
	stateJson?: string | null;
}

/** @public */
export interface ProcessRepoLike {
	/** @internal */
	create(input: ProcessCreateInputLike): ProcessInstance;
	/** @internal */
	getById(id: string): ProcessInstance | null;
	/** @public */
	listAll(): ProcessInstance[];
	/** Startup-only compatibility migrations may rewrite persisted process position and state. @public */
	update(
		id: string,
		input: {
			/** @public */
			selectedTurnId?: TurnId | null;
			/** @public */
			currentExecution?: ProcessInstance["currentExecution"];
			/** @public */
			stateJson?: string | null;
		},
	): ProcessInstance | null;
}

/** @public */
export interface ProcessProjectRepoLike {
	/** Server-provided project mutation service. Implementations should emit project.updated after committed writes. @internal */
	create(input: {
		/** @internal */
		instanceId: string;
		/** @internal */
		key: string;
		/** @internal */
		repoLocator: string;
		/** @internal */
		baseBranch: string;
		/** @internal */
		workBranch?: string | null;
		/** @internal */
		externalId?: string | null;
		/** @internal */
		externalUrl?: string | null;
		/** @internal */
		metadata?: Record<string, unknown> | null;
		/** @internal */
		pipelineStatus?: string | null;
	}): ProcessProject;
	/** @internal */
	getByInstanceAndKey(instanceId: string, key: string): ProcessProject | null;
	/** @public */
	update(
		id: string,
		input: {
			/** @internal */
			baseBranch?: string;
			/** @internal */
			workBranch?: string | null;
			/** @internal */
			externalId?: string | null;
			/** @internal */
			externalUrl?: string | null;
			/** @public */
			metadata?: Record<string, unknown> | null;
			/** @internal */
			pipelineStatus?: string | null;
		},
	): ProcessProject | null;
	/** @internal */
	listByInstance(instanceId: string): ProcessProject[];
}

/** @public */
export interface ProcessEventRepoLike {
	/** @public */
	create(input: {
		/** @public */
		instanceId: string;
		/** @public */
		eventType: string;
		/** @public */
		data?: Record<string, unknown>;
	}): unknown;
	/** @internal */
	listByInstance(instanceId: string, limit?: number): ProcessEvent[];
}

/** @internal */
export interface BroadcasterLike {
	/** @internal */
	sendDurable<T extends KnownDurableWsFrameType>(
		type: T,
		payload: WsPayloadByType[T],
		instanceId?: string,
	): void;
	/** @internal */
	sendEphemeral?<T extends KnownEphemeralWsFrameType>(
		type: T,
		payload: WsPayloadByType[T],
		instanceId?: string,
	): void;
}

/** @internal */
export type LaunchModelConfigInputLike = LaunchModelConfigInput;
/** @internal */
export type LauncherModelConfigSchemaLike = LauncherModelConfigSchema;
/** @internal */
export type LauncherModelConfigPreviewLike = LauncherModelConfigPreview;

/** @internal */
export interface LauncherModelConfigServiceLike {
	/** @internal */
	getSchema(launcherId: string): Promise<LauncherModelConfigSchemaLike | null>;
	/** @internal */
	preview(
		launcherId: string,
		launcherInput: Record<string, unknown>,
		opts?: {
			/** @internal */
			modelConfig?: LaunchModelConfigInputLike;
		},
	): Promise<LauncherModelConfigPreviewLike | null>;
}

/** Stable, machine-readable codes returned while preparing a launch. @internal */
export type LaunchPlanPreparationIssueCode =
	| "process_id_mismatch"
	| "invalid_turn_configs_json"
	| "unknown_model_profile"
	| "model_profile_not_allowed"
	| "unknown_llm_turn"
	| "selected_turn_model_requires_selected_turn"
	| "selected_turn_model_requires_llm_turn"
	| "model_required";

/** Complete, presentation-safe diagnostic returned while preparing a launch. @internal */
export interface LaunchPlanPreparationIssue {
	/** @internal */
	readonly code: LaunchPlanPreparationIssueCode;
	/** @internal */
	readonly message: string;
}

/** @internal */
export type LaunchPlanPreparationResultLike =
	| {
			/** @internal */
			ok: true;
			/** @internal */
			launchPlan: ProcessLaunchPlan;
			/** @internal */
			modelConfig: LaunchModelConfigInputLike;
			/** @internal */
			warnings: readonly LaunchPlanPreparationIssue[];
	  }
	| {
			/** @internal */
			ok: false;
			/** Normalized durable plan retained when a scheduled launch is blocked. @internal */
			launchPlan: ProcessLaunchPlan;
			/** @internal */
			modelConfig: LaunchModelConfigInputLike;
			/** @internal */
			errors: readonly LaunchPlanPreparationIssue[];
	  };

/** @internal */
export interface ProcessLaunchPlanServiceLike {
	/** @internal */
	prepare(
		launchPlan: ProcessLaunchPlan,
		opts?: {
			/** @internal */
			modelConfig?: LaunchModelConfigInputLike;
			/** @internal */
			replaceModelConfig?: boolean;
			/** @internal */
			invalidModelConfig?: "reject" | "omit";
		},
	): Promise<LaunchPlanPreparationResultLike>;
}

/** @internal */
export interface HandoffDedupKeyRecordLike {
	/** @internal */
	key: string;
	/** @internal */
	instanceId: string;
	/** @internal */
	createdAt: string;
	/** @internal */
	metadata: Record<string, unknown>;
}

/** @internal */
export interface HandoffDedupKeyServiceLike {
	/** @internal */
	getByKey(key: string): HandoffDedupKeyRecordLike | null;
}

/** @internal */
export interface WorkerSupervisorLike {
	/** @internal */
	spawnWorker(instanceId: string): Promise<unknown>;
	/** @internal */
	getWorker(instanceId: string): unknown | undefined;
}

/** @public */
export interface ProcessEngineResultLike {
	/** @public */
	ok: boolean;
	/** @internal */
	code?: string;
	/** @internal */
	message?: string;
	/** @internal */
	process?: ProcessInstance | null;
	/** @internal */
	stage?: "pre_commit" | "post_commit";
	/** @internal */
	data?: unknown;
}

/** @internal */
export interface DeferredProcessActivationExpected {
	/** @internal */
	processId: string;
	/** @internal */
	lifecycleStatus: ProcessLifecycleStatus;
	/** @internal */
	selectedTurnId: TurnId | null;
	/** @internal */
	title: string | null;
	/** @internal */
	paramsJson: string | null;
	/** @internal */
	projectId: string;
	/** @internal */
	projectKey: string;
	/** @internal */
	repoLocator: string;
	/** @internal */
	baseBranch: string;
	/** @internal */
	workBranch: string | null;
}

/** @internal */
export interface DeferredProcessActivationSnapshot extends DeferredProcessActivationExpected {
	/** @internal */
	instanceId: string;
	/** @internal */
	processMetadata: Record<string, unknown> | null;
	/** @internal */
	projectMetadata: Record<string, unknown> | null;
}

/** @internal */
export interface DeferredProcessActivationSnapshotQuery {
	/** @internal */
	projectKey: string;
	/** @internal */
	instanceId?: string;
	/** @internal */
	processId?: string;
}

/** @internal */
export type DeferredProcessActivationSnapshotResult =
	| {
			/** @internal */
			outcome: "ready";
			/** @internal */
			snapshots: DeferredProcessActivationSnapshot[];
	  }
	| {
			/** @internal */
			outcome: "process_not_found";
	  }
	| {
			/** @internal */
			outcome: "project_not_found";
	  };

/** @internal */
export interface DeferredProcessActivationEvent {
	/** @internal */
	eventType: string;
	/** @internal */
	data?: Record<string, unknown>;
	/** @internal */
	level: "info" | "warn" | "error";
	/** @internal */
	message: string;
}

/** @internal */
export interface PreparedDeferredProcessActivation {
	/** @internal */
	expected: DeferredProcessActivationExpected;
	/** @internal */
	workBranch: string;
	/** @internal */
	paramsJson: string;
	/** @internal */
	projectMetadata: Record<string, unknown> | null;
	/** @internal */
	selectedTurnId: TurnId;
	/** @internal */
	event: DeferredProcessActivationEvent;
	/** @internal */
	actor?: Actor;
}

/** @internal */
export type DeferredProcessActivationOutcome =
	| "activated"
	| "already_activated"
	| "stale"
	| "not_applicable"
	| "project_not_found"
	| "invalid_selected_turn";

/** @internal */
export interface DeferredProcessActivationFailure {
	/** @internal */
	expected: DeferredProcessActivationExpected;
	/** @internal */
	errorClass: WorkerErrorClass;
	/** @internal */
	event: DeferredProcessActivationEvent;
}

/** @internal */
export type ProcessActionExecutionSource = "ui" | "external" | "scheduled";
/** @internal */
export type ProcessActionExecutionOrigin = "web_ui" | "external_interface" | "scheduled";

/** @internal */
export interface ProcessActionSummaryLike {
	/** @internal */
	id: string;
	/** @internal */
	label: string;
	/** @internal */
	description?: string | null;
	/** @internal */
	form?: FormDefinition;
}

/** @internal */
export type ActionExecutionFailureStageLike = "pre_commit" | "post_commit";

/** @public */
export type ActionExecutionResultLike =
	| {
			/** @public */
			ok: true;
			/** @internal */
			process: ProcessInstance | null;
			/** @internal */
			data?: Record<string, unknown>;
			/** @internal */
			error?: undefined;
			/** @internal */
			code?: undefined;
			/** @internal */
			stage?: undefined;
	  }
	| {
			/** @public */
			ok: false;
			/** @internal */
			stage: "pre_commit";
			/** @internal */
			error: string;
			/** @internal */
			code?: string;
			/** @internal */
			process?: undefined;
			/** @internal */
			data?: undefined;
	  }
	| {
			/** @public */
			ok: false;
			/** @internal */
			stage: "post_commit";
			/** @internal */
			process: ProcessInstance;
			/** @internal */
			error: string;
			/** @internal */
			code?: string;
			/** @internal */
			data?: Record<string, unknown>;
	  };

/** @internal */
export interface ProcessActionServiceLike {
	/** @internal */
	listVisibleActions(instanceId: string): readonly ProcessActionSummaryLike[];
	/** @internal */
	executeAction(
		instanceId: string,
		actionId: string,
		input: Record<string, unknown>,
		opts?: {
			/** @internal */
			source?: ProcessActionExecutionSource;
			/** @internal */
			origin?: ProcessActionExecutionOrigin;
			/** @internal */
			nextTurnModelProfileId?: string | null;
			/** @internal */
			actor?: Actor;
		},
	): Promise<ActionExecutionResultLike>;
}

/** @public */
export interface ExternalObservationInput {
	/** @public */
	instanceId: string;
	/** @public */
	armingId: string;
	/** @public */
	generation: string;
	/** @public */
	observation?: {
		/** @public */
		summary: string;
		/** @internal */
		links?: import("@leitwerk-dev/domain").TurnProgressLink[];
		/** @public */
		observedAt: string;
		/** @public */
		subject: string;
		/** @public */
		revision: string;
	};
	/** @public */
	refreshError?: string;
}

/** @public */
export interface ExternalSourceArmingLike {
	/** Process-local arming id. Durable arming identity is { instanceId, id }. @public */
	id: string;
	/** @public */
	instanceId: string;
	/** @internal */
	processId: string;
	/** @internal */
	turnId: string;
	/** @internal */
	externalActionId: string;
	/** @internal */
	source: ExternalActionSource;
	/** @public */
	resolved: unknown;
	/** Opaque identity of this resolved subscription. @public */
	generation?: string;
}

/** @public */
export interface ExternalSourceFireInput {
	/** @public */
	instanceId: string;
	/** @public */
	armingId: string;
	/** Reject a superseded subscription instead of queuing its event for a later turn. @internal */
	generation?: string;
	/** @internal */
	input?: Record<string, unknown>;
	/** @public */
	event?: Record<string, unknown>;
	/** @public */
	mergeKey?: string | null;
}

/** @public */
export interface ExternalSourceServiceLike {
	/** @public */
	listArmed(kind: string): readonly ExternalSourceArmingLike[];
	/** @public */
	fire(input: ExternalSourceFireInput): Promise<ActionExecutionResultLike>;
	/** Records facts without firing an action or changing lifecycle state. @public */
	observe?(input: ExternalObservationInput): Promise<ActionExecutionResultLike>;
}

/** @internal */
export interface LauncherRecentValuesServiceLike {
	/** @internal */
	list(launcherId: string): Record<string, readonly string[]>;
	/** @internal */
	record(launcherId: string, launcherInput: Record<string, unknown>): void;
}

/** @internal */
export interface QueuedProcessInputLike {
	/** @internal */
	source: InputSource;
	/** @internal */
	kind: InputKind;
	/** @internal */
	bodyMarkdown: string;
	/** @internal */
	target?: ProcessInputTarget | null;
	/** Stable principal that queued this input. Defaults to SYSTEM_ACTOR at persist time. @internal */
	actor?: Actor;
}

/** @public */
export interface ProcessEngineLike {
	/** @internal */
	getDeferredProcessActivationSnapshots(
		query: DeferredProcessActivationSnapshotQuery,
	): DeferredProcessActivationSnapshotResult;
	/** @internal */
	activateDeferredProcess(
		instanceId: string,
		prepared: PreparedDeferredProcessActivation,
	): Promise<
		ProcessEngineResultLike & {
			/** @internal */
			data?: {
				/** @internal */
				outcome: DeferredProcessActivationOutcome;
			};
		}
	>;
	/** @internal */
	parkDeferredProcessActivationFailure(
		instanceId: string,
		failure: DeferredProcessActivationFailure,
	): Promise<
		ProcessEngineResultLike & {
			/** @internal */
			data?: {
				/** @internal */
				outcome: "parked" | "stale" | "not_applicable" | "project_not_found";
			};
		}
	>;
	/** @internal */
	startProcess(instanceId: string, startTurnId: TurnId): Promise<ProcessEngineResultLike>;
	/** @public */
	abortProcess(
		instanceId: string,
		opts?: {
			/** @internal */
			actor?: Actor;
		},
	): Promise<ProcessEngineResultLike>;
	/** Retries the current failed startup or accepted turn; startup retries consume no attempt. @public */
	retryProcess(
		instanceId: string,
		opts?: {
			/** @internal */
			nextTurnModelProfileId?: string | null;
			/** @internal */
			actor?: Actor;
		},
	): Promise<ProcessEngineResultLike>;
	/** @internal */
	continueFailedTurn(
		instanceId: string,
		turnRecordId: string,
		options?: {
			/** @internal */
			prompt?: string | null;
			/** @internal */
			nextTurnModelProfileId?: string | null;
			/** @internal */
			actor?: Actor;
		},
	): Promise<ProcessEngineResultLike>;
	/** @internal */
	queueInputs(
		instanceId: string,
		inputs: readonly QueuedProcessInputLike[],
		opts?: {
			/** @internal */
			dispatchErrorMessage?: string;
			/** @internal */
			actor?: Actor;
		},
	): Promise<ProcessEngineResultLike>;
}

/** @internal */
export interface ComponentConfigLike {
	/** @internal */
	repo: string;
	/** @internal */
	default_branch: string;
}

/** @public */
export interface RegisteredProcessWatcherLike<TConfig = unknown, TEvent = unknown> {
	/** @public */
	readonly processId: string;
	/** @internal */
	readonly processDisplayName: string;
	/** @public */
	readonly watcherId: string;
	/** @internal */
	readonly watcherLabel: string;
	/** @internal */
	readonly watcherDescription: string;
	/** @internal */
	readonly sourceId: string;
	/** @internal */
	readonly sourceLabel: string;
	/** @public */
	readonly enabled: boolean;
	/** @internal */
	readonly configPath: string;
	/** @public */
	readonly config: TConfig;
	/** @internal */
	readonly presentation: ProcessWatcherPresentation;
	/** @internal */
	readonly launchModelConfig: LaunchModelConfigInputLike;
	/** @internal */
	resolveLaunch(event: TEvent, ctx?: LauncherContext): Promise<ProcessLaunchPlan | null>;
	/** @internal */
	resolveLaunchAttempt(
		event: TEvent,
		ctx?: LauncherContext,
	): Promise<{
		/** @internal */
		launchConfig: ProcessLaunchConfig;
		/** @internal */
		launchPlan: ProcessLaunchPlan;
		/** @internal */
		preparationChecks: readonly LaunchPreparationCheck[];
	} | null>;
}

/** @public */
export interface WatcherLaunchResultLike extends ProgrammaticLaunchResultLike {}

/** @internal */
export interface ProgrammaticLaunchRequestLike {
	/** @internal */
	launcherId: string;
	/** @internal */
	launcherInput: Record<string, unknown>;
	/** @internal */
	title?: string | null;
	/** @internal */
	modelConfig?: LaunchModelConfigInputLike;
	/** @internal */
	skillIds?: readonly string[];
	/** Trusted, non-secret process metadata merged after launcher resolution. @internal */
	processMetadata?: Record<string, unknown>;
}

/** @public */
export interface ProgrammaticLaunchResultLike {
	/** @public */
	launchRunId: string;
	/** @public */
	process: ProcessInstance | null;
	/** @public */
	error: string | null;
}

/** @public */
export interface LaunchRunServiceLike {
	/** @internal */
	startProgrammatic(
		request: ProgrammaticLaunchRequestLike,
		opts: {
			/** @internal */
			idempotencyKey: string;
			/** @internal */
			actor?: Actor;
		},
	): Promise<ProgrammaticLaunchResultLike>;
	/** @public */
	startWatcher<TConfig, TEvent>(
		watcher: RegisteredProcessWatcherLike<TConfig, TEvent>,
		event: TEvent,
		opts: {
			/** @public */
			idempotencyKey: string;
			/** @internal */
			actor?: Actor;
		},
	): Promise<WatcherLaunchResultLike>;
}

/** @public */
export interface ProcessWatcherServiceLike {
	/** @internal */
	listAll(): readonly RegisteredProcessWatcherLike[];
	/** @public */
	listBySource<TConfig, TEvent>(
		source: ProcessWatcherSource<TConfig, TEvent>,
	): readonly RegisteredProcessWatcherLike<TConfig, TEvent>[];
}

/** @public */
export interface PollResultLike {
	/** @internal */
	readonly errors: readonly string[];
}

/** @public */
export interface PollingHandleLike<T extends PollResultLike = PollResultLike> {
	/** @public */
	poll(): Promise<T>;
}

/** @public */
export interface PollingServiceLike {
	/** @public */
	create<T extends PollResultLike>(options: {
		/** @public */
		id: string;
		/** @public */
		pollOnce(): Promise<T>;
		/** @public */
		isEnabled(): boolean;
		/** @public */
		pollInterval(): string;
		/** @public */
		defaultIntervalMs?: number;
	}): PollingHandleLike<T>;
}

/** @internal */
export interface ProcessQuestionServiceLike {
	/** @internal */
	listOpen(instanceId?: string): readonly import("@leitwerk-dev/domain").ProcessQuestionRequest[];
	/** @internal */
	submitAnswers(
		instanceId: string,
		requestId: string,
		draft: readonly import("@leitwerk-dev/domain").QuestionAnswerDraft[],
		actor: Actor,
	): Promise<
		| {
				/** @internal */
				ok: true;
				/** @internal */
				request: import("@leitwerk-dev/domain").ProcessQuestionRequest;
		  }
		| {
				/** @internal */
				ok: false;
				/** @internal */
				code: "not_found" | "not_current" | "invalid";
				/** @internal */
				message: string;
				/** @internal */
				request?: import("@leitwerk-dev/domain").ProcessQuestionRequest;
		  }
	>;
}

/** @public */
export interface CoreServerSetupDeps {
	/** @internal */
	serverBaseUrl: string;
	/** @internal */
	processWorkspacesDir?: string;
	/** @internal */
	components: Record<string, ComponentConfigLike>;
	/** Typed by consuming extensions via watcher-utils ExternalWriteLogRepoLike. @public */
	externalWrites: unknown;
	/** @public */
	processes: ProcessRepoLike;
	/** @public */
	projects: ProcessProjectRepoLike;
	/** @public */
	events: ProcessEventRepoLike;
	/** @internal */
	broadcaster: BroadcasterLike;
	/** @public */
	commands: ProcessEngineLike;
	/** @internal */
	processActions: ProcessActionServiceLike;
	/** @public */
	externalSources: ExternalSourceServiceLike;
	/** @internal */
	getSupervisor: () => WorkerSupervisorLike | undefined;
	/** @internal */
	launcherService: ProcessLauncherService;
	/** @internal */
	launcherRecentValues: LauncherRecentValuesServiceLike;
	/** @internal */
	launcherModelConfigs: LauncherModelConfigServiceLike;
	/** @internal */
	launchPlans: ProcessLaunchPlanServiceLike;
	/** @internal */
	handoffDedupKeys?: HandoffDedupKeyServiceLike;
	/** @public */
	processWatchers?: ProcessWatcherServiceLike;
	/** @public */
	launchRuns: LaunchRunServiceLike;
	/** @public */
	polling: PollingServiceLike;
	/** @internal */
	processModelSelection?: ProcessModelSelectionServiceLike;
	/** Durable active-turn questions for trusted operator-channel extensions. @internal */
	processQuestions?: ProcessQuestionServiceLike;
	/** Registration boundary for secret-backed repository credential extensions. @internal */
	repositoryCredentials: RepositoryCredentialRegistrar;
	/** Server-owned managed result images, available to trusted delivery extensions. @internal */
	resultImages?: {
		/** @internal */
		get(instanceId: string, turnRecordId: string, imageId: string): Promise<Uint8Array | null>;
	};
}

/** @internal */
export type ProcessActionModelPreviewLike = ProcessActionModelPreview;

/** @internal */
export type ProcessModelSelectionPreviewFailureCode =
	| "process_not_found"
	| "instance_tree_unavailable";

/** @internal */
export type ProcessModelSelectionPreviewResultLike =
	| ProcessActionModelPreviewLike
	| {
			/** @internal */
			kind: "operational_failure";
			/** @internal */
			code: ProcessModelSelectionPreviewFailureCode;
	  };

/** @internal */
export interface ModelProfileOptionSummaryLike {
	/** @internal */
	id: string;
	/** @internal */
	label: string;
	/** @internal */
	description: string;
	/** @internal */
	availability: "available" | "unavailable" | "stale";
}

/** @internal */
export interface ProcessModelSelectionServiceLike {
	/** @internal */
	listAvailableProfiles(instanceId: string): readonly ModelProfileOptionSummaryLike[] | null;
	/** @internal */
	preview(
		instanceId: string,
		actionId: string,
		input: Record<string, unknown>,
	): Promise<ProcessModelSelectionPreviewResultLike>;
}

/** @public */
export const coreHostCapabilities = {
	/** @public */
	serverSetup: createCapabilityToken<CoreServerSetupDeps>("core:serverSetup"),
	/** @internal */
	processModelSelection: createCapabilityToken<ProcessModelSelectionServiceLike>(
		"core:processModelSelection",
	),
} as const;
