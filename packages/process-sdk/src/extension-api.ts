import type {
	Actor,
	InputKind,
	InputSource,
	LaunchModelConfigInput,
	ProcessCustomizableFields,
	ProcessInputTarget,
	ProcessInstance,
	ProcessLifecycleStatus,
	ProcessProject,
	ProcessSemanticEntryRefKey,
	ProcessTurnRecord,
	TurnId,
	TurnProgressReport,
} from "@leitwerk-dev/domain";
import type { ExternalWrites } from "@leitwerk-dev/external-writes";
import type { WatcherPresentationField } from "@leitwerk-dev/protocol";
import type { CapabilityToken } from "./capabilities.js";
import type { FormDefinition } from "./form-contract.js";

export type { FormDefinition, FormFieldDefinition } from "./form-contract.js";

import type {
	LlmTurnDefinition,
	ProcessEffectPlan,
	ProcessLifecycleEffects,
	TurnDefinition,
} from "./define-process.js";
import type {
	LauncherCardMetadata,
	LauncherFieldOptionDefinition,
	LauncherSchemaDefinition,
	LauncherValidationError,
	UiLauncherSummaryBase,
} from "./launcher-contract.js";
import type { ModelProviderSet } from "./model-provider.js";
import type {
	ServerExtensionEventMap,
	ServerExtensionEventPayloadInputMap,
} from "./server-events.js";
import type { ToolCallRendererDefinition } from "./tool-renderers.js";
import type {
	EventBus,
	PiTreeEntry,
	ProcessActionPreviewDefinition,
	ProcessActionSchedulingDefinition,
	ProcessPiConfig,
	TurnOptions,
} from "./types.js";

/** @public */
export interface Codec<T> {
	/** @public */
	parse(value: unknown): T;
	/** @public */
	serialize(value: T): unknown;
}

/** @internal */
export interface LauncherModelProfileSummary {
	/** @internal */
	readonly id: string;
	/** @internal */
	readonly provider: string;
	/** @internal */
	readonly modelId: string;
	/** @internal */
	readonly thinkingLevel: string;
}

/** @public */
export interface LauncherContext {
	/** @internal */
	readonly process?: ProcessInstance;
	/** @internal */
	readonly projects?: readonly ProcessProject[];
	/**
	 * Effective model profiles available to this launch path.
	 * The server may filter this list per process (for example via process allowlists)
	 * before invoking UI launcher or process watcher code.
	 */
	/** @internal */
	readonly modelProfiles?: readonly LauncherModelProfileSummary[];
}

/** @public */
export type LauncherVisibility = "ui";

/** @public */
export interface ProcessLaunchProjectConfig {
	/** @public */
	key: string;
	/** @public */
	repoLocator: string;
	/** @public */
	baseBranch: string;
	/** @public */
	workBranch?: string | null;
	/** @public */
	externalId?: string | null;
	/** @public */
	externalUrl?: string | null;
	/** @public */
	metadata?: Record<string, unknown> | null;
}

/** @public */
export interface ProcessTitleSourceField {
	/** Short label shown to the title-generation model, e.g. "Prompt" or "Summary". @public */
	label: string;
	/** Launcher-selected descriptive text to summarize into a short operator-facing title. @public */
	value: string;
}

/** @public */
export interface ProcessLaunchConfig<TParams = unknown> {
	/** @public */
	processId: string;
	/** @public */
	params: TParams;
	/** @public */
	startTurnId?: TurnId | null;
	/** Explicit operator-facing title. UI launches may override this with the built-in title input before persistence. @public */
	title?: string | null;
	/** Explicit launcher-selected fields for optional server-side title generation when title is blank. @public */
	titleSourceFields?: readonly ProcessTitleSourceField[];
	/** @public */
	externalId?: string | null;
	/** @public */
	externalUrl?: string | null;
	/** @public */
	metadata?: Record<string, unknown> | null;
	/** @internal */
	defaultModelProfileId?: string | null;
	/** @internal */
	turnConfigs?: Record<
		string,
		{
			/** @internal */
			modelProfileId?: string | null;
		}
	>;
	/** Skill ids resolved to active immutable revisions before process creation. @internal */
	skillIds?: readonly string[];
	/** @public */
	projects?: readonly ProcessLaunchProjectConfig[];
}

/** @public */
export type UiLauncherConfigResolution<TParams = unknown> =
	| {
			/** @public */
			ok: true;
			/** @public */
			launchConfig: ProcessLaunchConfig<TParams>;
	  }
	| {
			/** @public */
			ok: false;
			/** @public */
			errors: readonly LauncherValidationError[];
	  };

/** @public */
export interface LaunchPreparationContext<TParams = unknown> {
	/** @public */
	readonly signal: AbortSignal;
	/** @public */
	readonly launchConfig: ProcessLaunchConfig<TParams>;
	/** @public */
	readonly logger: {
		/** @internal */
		info(message: string): void;
		/** @public */
		warn(message: string): void;
	};
}

/** @public */
export interface LaunchPreparationCheck<TParams = unknown> {
	/** @public */
	readonly id: string;
	/** @public */
	readonly label: string;
	/** @public */
	run(ctx: LaunchPreparationContext<TParams>): Promise<void>;
}

/** A launcher check may throw this error to expose bounded operator-safe remediation. @public */
export class SafeLaunchPreparationError extends Error {
	/** @public */
	constructor(
		message: string,
		/** @internal */
		readonly safeSummary: string,
	) {
		super(message);
		this.name = "SafeLaunchPreparationError";
	}
}

/** @public */
export interface UiLauncherDefinition<TParams = unknown> {
	/** @public */
	card: LauncherCardMetadata;
	/** @public */
	launchConfigSchema: LauncherSchemaDefinition;
	/** @public */
	resolveDefaults?(
		ctx: LauncherContext,
	): Record<string, unknown> | Promise<Record<string, unknown>>;
	/** @public */
	resolveOptions?(
		input: Record<string, unknown>,
		ctx: LauncherContext,
	):
		| Record<string, readonly LauncherFieldOptionDefinition[]>
		| Promise<Record<string, readonly LauncherFieldOptionDefinition[]>>;
	/**
	 * Convert persisted operator input into a new-launch draft. The default preserves
	 * the complete input. Launchers override this only for values that must be rebuilt.
	 */
	/** @public */
	resolveRelaunchInput?(
		previousInput: Record<string, unknown>,
		ctx: LauncherContext,
	): Record<string, unknown> | Promise<Record<string, unknown>>;
	/** @public */
	preparationChecks?(
		input: Record<string, unknown>,
		launchConfig: ProcessLaunchConfig<TParams>,
	): readonly LaunchPreparationCheck<TParams>[];
	/** @public */
	resolveLaunchConfig(
		input: Record<string, unknown>,
		ctx: LauncherContext,
	): UiLauncherConfigResolution<TParams> | Promise<UiLauncherConfigResolution<TParams>>;
}

/** @public */
export interface ProcessWatcherPresentation {
	/** @public */
	readonly targetSummary: string;
	/** @public */
	readonly details?: readonly WatcherPresentationField[];
}

/** @public */
export interface ParsedProcessWatcherConfig<TConfig = unknown> {
	/** @public */
	readonly config: TConfig;
	/** @public */
	readonly enabled: boolean;
	/** @public */
	readonly launchModelConfig?: LaunchModelConfigInput;
}

/** A watcher source is defined and owned by the extension that implements it. @public */
export interface ProcessWatcherSource<TConfig = unknown, TEvent = unknown> {
	/** @public */
	readonly id: string;
	/** @public */
	readonly label: string;
	/** Type-only marker used to carry the provider event type across the source seam. @internal */
	readonly eventType?: TEvent;
	/** @public */
	parseConfig(raw: unknown): ParsedProcessWatcherConfig<TConfig>;
	/** @public */
	presentConfig(config: TConfig): ProcessWatcherPresentation;
}

/** @public */
export interface ProcessWatcherDefinition<TParams = unknown, TEvent = unknown, TConfig = unknown> {
	/** @public */
	id: string;
	/** @public */
	label: string;
	/** @public */
	description: string;
	/** @public */
	source: ProcessWatcherSource<TConfig, TEvent>;
	/** @internal */
	matches?(event: TEvent, ctx: LauncherContext): boolean | Promise<boolean>;
	/** @public */
	preparationChecks?(
		event: TEvent,
		launchConfig: ProcessLaunchConfig<TParams>,
	): readonly LaunchPreparationCheck<TParams>[];
	/** @public */
	resolveLaunchConfig(
		event: TEvent,
		ctx: LauncherContext,
	): ProcessLaunchConfig<TParams> | Promise<ProcessLaunchConfig<TParams>>;
}

/** @public */
export interface ProcessLauncherDefinition<TParams = unknown> {
	/** @public */
	id: string;
	/** @public */
	label: string;
	/** @public */
	description: string;
	/** @public */
	visibility: LauncherVisibility;
	/** @public */
	ui: UiLauncherDefinition<TParams>;
}

/** @internal */
export interface ProcessLaunchPlanProcessInput extends ProcessCustomizableFields {
	/** @internal */
	processId: string;
	/** @internal */
	selectedTurnId: string | null;
	/** @internal */
	lifecycleStatus: ProcessLifecycleStatus;
	/** @internal */
	paramsJson: string | null;
	/** @internal */
	stateJson: string | null;
}

/** @internal */
export interface ProcessLaunchPlan {
	/** @internal */
	launcherId: string;
	/** @internal */
	processId: string;
	/** @internal */
	processInput: ProcessLaunchPlanProcessInput;
	/** Optional server-owned idempotency key for cross-process handoffs. @internal */
	handoffDedupKey?: string | null;
	/** Carry-forward launcher-selected fields for optional server-side title generation. @internal */
	titleSourceFields?: readonly ProcessTitleSourceField[];
	/** @internal */
	projectInputs: readonly ProcessLaunchProjectConfig[];
	/** @internal */
	startTurnId: TurnId | null;
	/** @internal */
	skillIds?: readonly string[];
}

/** @internal */
export interface ResolvedProcessLauncher<TParams = unknown> {
	/** @internal */
	launcherId: string;
	/** @internal */
	processId: string;
	/** @internal */
	displayName: string;
	/** @internal */
	launchConfig: ProcessLaunchConfig<TParams>;
	/** @internal */
	launchPlan: ProcessLaunchPlan;
}

/** @internal */
export type UiLauncherResolutionResult<TParams = unknown> =
	| {
			/** @internal */
			ok: true;
			/** @internal */
			launcher: ResolvedProcessLauncher<TParams>;
	  }
	| {
			/** @internal */
			ok: false;
			/** @internal */
			errors: readonly LauncherValidationError[];
	  };

/** @internal */
export interface UiLauncherSummary extends UiLauncherSummaryBase {}

/** @internal */
export interface ProcessLauncherService {
	/** @internal */
	listUiLaunchers(): readonly UiLauncherSummary[];
	/** @internal */
	resolveUiDefaults(launcherId: string, ctx?: LauncherContext): Promise<Record<string, unknown>>;
	/** @internal */
	resolveUiOptions(
		launcherId: string,
		input: Record<string, unknown>,
		ctx?: LauncherContext,
	): Promise<Record<string, readonly LauncherFieldOptionDefinition[]>>;
	/** @internal */
	resolveUiRelaunchInput(
		launcherId: string,
		previousInput: Record<string, unknown>,
		ctx?: LauncherContext,
	): Promise<Record<string, unknown>>;
	/** @internal */
	resolvePreparationChecks?(
		launcherId: string,
		input: Record<string, unknown>,
		launchConfig: ProcessLaunchConfig,
	): readonly LaunchPreparationCheck[];
	/** @internal */
	resolveUiLauncher(
		launcherId: string,
		input: Record<string, unknown>,
		ctx?: LauncherContext,
	): Promise<UiLauncherResolutionResult>;
}

/** Resolve a UI launcher summary by id, returning `null` when it is unknown. @internal */
export function findUiLauncherById(
	launcherService: Pick<ProcessLauncherService, "listUiLaunchers">,
	launcherId: string,
): UiLauncherSummary | null {
	return launcherService.listUiLaunchers().find((launcher) => launcher.id === launcherId) ?? null;
}

/** @public */
export interface ProcessTurnOutcomeEvent {
	/** @internal */
	turnRecordId: string;
	/** @internal */
	turnId: string;
	/** @internal */
	outcome: string;
	/** @public */
	params: Record<string, unknown>;
	/** @internal */
	turnResultMarkdown?: string | null;
}

/** @internal */
export type ProcessCleanupReason = "abort";

/** @internal */
export interface ProcessCleanupResult<TState = unknown> extends ProcessLifecycleEffects {
	/** @internal */
	state?: TState;
}

/** @internal */
export interface ProcessCleanupContext<TParams = unknown, TState = unknown>
	extends ProcessSnapshotContext<TParams, TState> {
	/** @internal */
	readonly reason: ProcessCleanupReason;
}

/** @internal */
export type ProcessCleanupHandler<TParams = unknown, TState = unknown> = (
	ctx: ProcessCleanupContext<TParams, TState>,
) => undefined | ProcessCleanupResult<TState> | Promise<ProcessCleanupResult<TState> | undefined>;

/** @internal */
export interface LeafOutcomeCaptureContext<TParams = unknown, TState = unknown>
	extends ProcessSnapshotContext<TParams, TState> {
	/** @internal */
	readonly leaf: {
		/** @internal */
		entryId: string;
		/** @internal */
		turnRecordId: string | null;
	};
	/** @internal */
	readonly turnRecord: ProcessTurnRecord | null;
	/** @internal */
	readTreeEntry(entryId: string): PiTreeEntry | null;
	/** @internal */
	readLeafEntry(): PiTreeEntry | null;
	/** @internal */
	readTurnRecord(turnRecordId: string): ProcessTurnRecord | null;
}

/** @internal */
export interface LeafOutcomeCaptureResult {
	/** @internal */
	rendererId: string;
	/** @internal */
	schemaVersion?: number;
	/** @internal */
	props: Record<string, unknown>;
	/** @internal */
	fallbackMarkdown?: string | null;
}

/** @internal */
export interface ProcessLeafOutcomeDefinition<TParams = unknown, TState = unknown> {
	/** @internal */
	rendererId: string;
	/** @internal */
	capture(
		ctx: LeafOutcomeCaptureContext<TParams, TState>,
	): Promise<LeafOutcomeCaptureResult | null> | LeafOutcomeCaptureResult | null;
}

/** @internal */
export interface ProcessActionDefinition<TParams = unknown, TState = unknown> {
	/** @internal */
	id: string;
	/** @internal */
	label: string;
	/** @internal */
	form?: FormDefinition;
	/** @internal */
	preview?: ProcessActionPreviewDefinition;
	/** @internal */
	scheduling?: ProcessActionSchedulingDefinition;
	/**
	 * Explicitly marks an action as an immediate-only side-effect command. Such
	 * actions must declare execute(...), cannot participate in pure preview or
	 * scheduling flows, and are run only by immediate action execution.
	 */
	/** @internal */
	executionMode?: "side_effect";
	/**
	 * Optional pure planner used for side-effect-free previews, scheduling validation,
	 * and immediate execution. The shared server runtime collects the declared
	 * transition/input/event plan from this hook without committing side effects
	 * while the hook runs.
	 */
	/** @internal */
	plan?(input: Record<string, unknown>, ctx: ServerProcessContext<TParams, TState>): Promise<void>;
	/**
	 * Imperative hook for actions with executionMode: "side_effect". Use only for
	 * immediate side effects that cannot be represented as a pure plan(...).
	 */
	/** @internal */
	execute?(
		input: Record<string, unknown>,
		ctx: ServerProcessContext<TParams, TState>,
	): Promise<void>;
}

/** @internal */
export type ServerTransitionRuntime = "reconcile" | "restart_worker";

/** @internal */
export interface ServerTransitionEffect {
	/**
	 * Declares how the server runtime should handle the worker context after the
	 * durable transition is committed.
	 */
	/** @internal */
	runtime?: ServerTransitionRuntime;
}

/** @internal */
export interface ServerTransitionRequest<TState = unknown> {
	/** @internal */
	lifecycleStatus?: ProcessLifecycleStatus;
	/** @internal */
	turnId?: TurnId | null;
	/** @internal */
	state?: TState;
	/** State machine trigger for the selected-turn graph. @internal */
	trigger?: string;
	/** @internal */
	effect?: ServerTransitionEffect;
}

/** @public */
export interface ProcessSnapshotContext<TParams = unknown, TState = unknown> {
	/** @public */
	readonly process: ProcessInstance;
	/** @public */
	readonly projects: readonly ProcessProject[];
	/** @public */
	readonly params: TParams;
	/** @public */
	readonly state: TState;
}

/** @public */
export type ExternalSourceInputMode = "none" | "input" | "instruction";

/** @public */
export interface ExternalSourceResolveContext<TParams = unknown, TState = unknown>
	extends ProcessSnapshotContext<TParams, TState> {}

/** @public */
export interface ExternalSourceEffectContext<
	TParams = unknown,
	TState = unknown,
	TEvent = unknown,
	TInput extends Record<string, unknown> = Record<string, unknown>,
> extends ProcessSnapshotContext<TParams, TState> {
	/** @public */
	readonly event: TEvent;
	/** @internal */
	readonly input: TInput;
}

/** @public */
export type ExternalSourceEffect<
	TParams = unknown,
	TState = unknown,
	TEvent = unknown,
	TInput extends Record<string, unknown> = Record<string, unknown>,
> = (
	ctx: ExternalSourceEffectContext<TParams, TState, TEvent, TInput>,
) => ProcessEffectPlan<TState> | Promise<ProcessEffectPlan<TState> | undefined> | undefined;

/** @public */
export interface ExternalEventDescription {
	/** @public */
	summary: string;
	/** @internal */
	markdown?: string;
	/** @public */
	links?: import("@leitwerk-dev/domain").TurnProgressLink[];
}

/** @public */
export interface ExternalActionSource<
	TParams = unknown,
	TState = unknown,
	_TEvent = unknown,
	_TInput extends Record<string, unknown> = Record<string, unknown>,
> {
	/** @public */
	kind: string;
	/** @public */
	label?: string;
	/** @public */
	description?: string;
	/** Pure description captured when the event is consumed. @public */
	describeEvent?(event: _TEvent): ExternalEventDescription;
	/**
	 * Extension-owned opaque config. Core may persist, hash, and display it, but must not
	 * interpret provider-specific fields.
	 */
	/** @public */
	config: unknown;
	/** Source-provided input behavior. Provider input is only published when the external action declares publishInput. @public */
	inputMode?: ExternalSourceInputMode;
	/** Optional extension-owned resolver for process-instance-specific matching. @public */
	resolve?(ctx: ExternalSourceResolveContext<TParams, TState>): unknown;
}

/** @public */
export interface ServerProcessContext<TParams = unknown, TState = unknown>
	extends ProcessSnapshotContext<TParams, TState> {
	/** @internal */
	transition(next: ServerTransitionRequest<TState>): Promise<void>;
	/** @internal */
	emitEvent<K extends keyof ServerExtensionEventMap & string>(
		eventType: K,
		data: ServerExtensionEventPayloadInputMap[K],
	): void;
	/**
	 * Resolves non-empty turn-result markdown for the current semantic ref.
	 * Returns `null` when the ref is unset or the referenced turn result does not
	 * carry operator-facing markdown. Throws when persisted semantic-ref state is
	 * malformed.
	 */
	/** @internal */
	readSemanticTurnResultMarkdown(ref: ProcessSemanticEntryRefKey): string | null;
	/**
	 * Resolves non-empty turn-result markdown for a process-defined published product.
	 * Returns `null` when the product ref is unset or the referenced turn result does
	 * not carry operator-facing markdown. Throws when persisted product-ref state is
	 * malformed.
	 */
	/** @internal */
	readProductTurnResultMarkdown(productName: string): string | null;
	/**
	 * Queue durable process input for worker delivery.
	 * Use `source: "action_prompt"` for action-originated follow-up prompts.
	 * When `target` is set, the worker appends the input on the referenced
	 * semantic or product branch before the next selected LLM turn continues from
	 * that same branch. For `action_prompt` targeted follow-up reruns, that queued
	 * input is the only new instruction: the worker does not replay the original
	 * kickoff prompt.
	 */
	/** @public */
	queueInput(input: {
		/** @public */
		source: InputSource;
		/** @public */
		kind: InputKind;
		/** @public */
		bodyMarkdown: string;
		/** @public */
		target?: ProcessInputTarget;
	}): void;
	/**
	 * Internal SDK lifecycle-effect collector used by high-level process authoring
	 * helpers. Raw process definitions should prefer intent helpers instead of
	 * constructing these effects directly.
	 */
	/** @internal */
	applyLifecycleEffects?(effects: ProcessLifecycleEffects): void;
}

/** @public */
export interface WorkerProcessContext<TParams = unknown, TState = unknown>
	extends ProcessSnapshotContext<TParams, TState> {
	/** @internal */
	readonly turnResultMarkdownBySemanticRef?: Partial<Record<ProcessSemanticEntryRefKey, string>>;
	/** @internal */
	readonly turnResultMarkdownByProduct?: Readonly<Record<string, string>>;
	/** Absolute workspace root for the current process instance, when available. @internal */
	readonly workspaceRoot?: string;
	/** Durable output produced by this LLM turn's preparation phase, when declared. @internal */
	readonly prepared?: unknown;
	/** Invoke a server-owned integration tool authorized for this automatic turn or LLM preparation. @internal */
	callIntegrationTool?(name: string, args: Record<string, unknown>): Promise<unknown>;
	/** Replace the durable operator-facing progress report for this turn attempt. @internal */
	reportProgress?(report: TurnProgressReport): void;
}

/** @public */
export interface WorkerCompleteInput<TOutcome extends string = string> {
	/** @internal */
	outcome: TOutcome;
	/** @internal */
	params?: Record<string, unknown>;
	/** @internal */
	markdown?: string | null;
	/** @internal */
	resultSummary?: string;
}

/** @internal */
export interface WorkerRunHandle<TParams = unknown, TState = unknown> {
	/** @internal */
	readonly ctx: WorkerProcessContext<TParams, TState>;
	/** @internal */
	turn<TOutcome extends string>(
		def: LlmTurnDefinition<TOutcome, TParams, TState>,
		options?: TurnOptions,
	): Promise<{
		/** @internal */
		outcome: TOutcome;
		/** @internal */
		params: Record<string, unknown>;
	}>;
	/** @internal */
	complete<TOutcome extends string>(input: WorkerCompleteInput<TOutcome>): Promise<void>;
	/** @internal */
	park(reason?: string): void;
}

/** @internal */
export type WorkerTurnHandler<TParams = unknown, TState = unknown> = (
	run: WorkerRunHandle<TParams, TState>,
) => Promise<void>;

/** @internal */
export interface ServerProcessAPI<TParams = unknown, TState = unknown> {
	/** @internal */
	action(def: ProcessActionDefinition<TParams, TState>): void;
	/** @internal */
	onTurnOutcome(
		turnId: string,
		handler: (
			event: ProcessTurnOutcomeEvent,
			ctx: ServerProcessContext<TParams, TState>,
		) => void | Promise<void>,
	): void;
	/** @internal */
	onCleanup(handler: ProcessCleanupHandler<TParams, TState>): void;
}

/** @internal */
export interface WorkerProcessAPI<TParams = unknown, TState = unknown> {
	/** @internal */
	start(turnId: TurnId): void;
	/** @internal */
	turn(turnId: TurnId, handler: WorkerTurnHandler<TParams, TState>): void;
}

/** @public */
export interface UiProcessAPI<TParams = unknown, TState = unknown> {
	/** @internal */
	leafOutcome(def: ProcessLeafOutcomeDefinition<TParams, TState>): void;
}

/** @public */
export interface ProcessLauncherAPI<TParams = unknown> {
	/** @public */
	launcher(def: ProcessLauncherDefinition<TParams>): void;
}

/** @public */
export interface ProcessWatcherAPI<TParams = unknown> {
	/** @public */
	watcher<TEvent = unknown, TConfig = unknown>(
		def: ProcessWatcherDefinition<TParams, TEvent, TConfig>,
	): void;
}

/** @public */
export interface ProcessTurnBinding<TTurn = TurnDefinition> {
	/** @public */
	definition: TTurn;
}

/** @public */
export type RepositoryCredentialKind = "git_ssh" | "git_https";

/** Non-secret, code-defined repository authentication request. @public */
export interface RepositoryCredentialRequirement {
	/** @public */
	readonly projectKey: string;
	/** @public */
	readonly kind: RepositoryCredentialKind;
	/** @public */
	readonly credentialRef: string;
}

/** Project fields available while deriving repository credential requirements. @public */
export interface RepositoryCredentialProject {
	/** @internal */
	readonly key: string;
	/** @internal */
	readonly repoLocator: string;
	/** @internal */
	readonly baseBranch: string;
	/** @internal */
	readonly workBranch: string | null;
}

/** Secret material is intentionally restricted to server registration and worker.start. @internal */
export interface GitSshCredentialMaterial {
	/** @internal */
	readonly privateKey: string;
	/** @internal */
	readonly knownHosts: string;
}

/** @internal */
export interface GitHttpsCredentialMaterial {
	/** HTTPS origin authorized by the credential-owning extension. @internal */
	readonly origin: string;
	/** @internal */
	readonly username: string;
	/** @internal */
	readonly password: string;
}

/** @internal */
export type RepositoryCredentialProvider =
	| {
			/** @internal */
			readonly kind: "git_ssh";
			/** @internal */
			resolve(credentialRef: string): GitSshCredentialMaterial | null;
	  }
	| {
			/** @internal */
			readonly kind: "git_https";
			/** @internal */
			resolve(credentialRef: string): GitHttpsCredentialMaterial | null;
	  };

/** @internal */
export interface RepositoryCredentialRegistrar {
	/** @internal */
	register(provider: RepositoryCredentialProvider): void;
}

/** @public */
export interface ProcessRuntimeCapabilities {
	/** Install repository-declared development tools with mise before accepting work. @internal */
	readonly developmentTools?: boolean;
	/** Require a Docker CLI connected to a private or explicitly acknowledged daemon. @public */
	readonly docker?: boolean;
}

/** @public */
export interface ExtensionProcessDefinition<TParams = unknown, TState = unknown> {
	/** @public */
	id: string;
	/** @public */
	displayName: string;
	/** Primary entry used when a launch does not select a start turn explicitly. @public */
	entryTurnId: TurnId;
	/** Additional entry turns that launchers may select explicitly. @public */
	alternateEntryTurnIds?: readonly TurnId[];
	/**
	 * Optional author-declared happy path: the ordered spine of turns a successful
	 * run walks through. Flow diagrams render this as the main line and hang every
	 * other turn off it as a branch. When omitted, consumers fall back to a derived
	 * best-effort spine.
	 */
	/** @public */
	happyPath?: readonly TurnId[];
	/** @public */
	turns: ReadonlyMap<TurnId, ProcessTurnBinding<TurnDefinition<TParams, TState>>>;
	/** @public */
	paramsCodec: Codec<TParams>;
	/** @public */
	stateCodec: Codec<TState>;
	/** @public */
	initialState(params: TParams): TState;
	/** Process-owned runtime capabilities. All capabilities default to disabled. @public */
	runtime?: ProcessRuntimeCapabilities;
	/**
	 * Server-only Kubernetes process-volume size, derived from extension configuration.
	 * Explicit process storage_size wins; undefined uses the runner default.
	 * Called before provisioning on worker starts. Must be synchronous and side-effect free;
	 * repeated calls never resize or replace an existing volume.
	 */
	/** @internal */
	resolveStorageSize?(input: {
		/** @internal */
		params: TParams;
		/** @internal */
		projects: readonly ProcessProject[];
	}): string | undefined;
	/** Runtime-only requirements; references are non-secret and remain in opaque params JSON. @public */
	repositoryCredentials?(input: {
		/** @public */
		params: TParams;
		/** @public */
		projects: readonly RepositoryCredentialProject[];
	}): readonly RepositoryCredentialRequirement[];
	/** @public */
	piConfig?: ProcessPiConfig;
	/** @internal */
	server?: (api: ServerProcessAPI<TParams, TState>) => void;
	/** @internal */
	worker?: (api: WorkerProcessAPI<TParams, TState>) => void;
	/** @public */
	ui?: (api: UiProcessAPI<TParams, TState>) => void;
	/** @public */
	launchers?: (api: ProcessLauncherAPI<TParams>) => void;
	/** @public */
	watchers?: (api: ProcessWatcherAPI<TParams>) => void;
}

/** @public */
export interface CatalogExtensionAPI {
	/** @internal */
	readonly events: EventBus;
	/** @public */
	registerProcess<TParams = unknown, TState = unknown>(
		def: ExtensionProcessDefinition<TParams, TState>,
	): void;
	/** @internal */
	registerToolRenderer(def: ToolCallRendererDefinition): void;
	/** @internal */
	provide<T>(token: CapabilityToken<T>, value: T): void;
	/** @internal */
	get<T>(token: CapabilityToken<T>): T | T[] | undefined;
	/** @internal */
	require<T>(token: CapabilityToken<T>): T | T[];
}

/** @public */
export type ExtensionLifecycleHook = () => void | Promise<void>;

/** @public */
export interface ServerExtensionLogger {
	/** @public */
	info?(payload: Record<string, unknown>, message?: string): void;
	/** @public */
	warn?(payload: Record<string, unknown>, message?: string): void;
	/** @public */
	error?(payload: Record<string, unknown>, message?: string): void;
}

/** @public */
export interface TicketCreationDestinationSummary {
	/** Adapter-owned opaque identifier. Browsers must not construct or interpret it. @public */
	readonly id: string;
	/** @public */
	readonly displayName: string;
	/** @public */
	readonly group?: string;
	/** @public */
	readonly description?: string;
}

/** @public */
export interface TicketCreationDestinationList {
	/** @public */
	readonly destinations: readonly TicketCreationDestinationSummary[];
	/** @public */
	readonly warnings?: readonly string[];
}

/** @public */
export interface TicketCreationDestinationSnapshot {
	/** @public */
	readonly summary: TicketCreationDestinationSummary;
	/** Adapter-owned, JSON-serializable immutable destination state. @public */
	readonly data: unknown;
	/** Untrusted destination context included in the ticket agent prompt. @public */
	readonly agentContext?: string;
}

/** @public */
export interface TicketCreationDestinationContext {
	/** @public */
	readonly actor: Actor;
}

/** @public */
export interface TicketCreationDestinationProvider {
	/** @public */
	list(ctx: TicketCreationDestinationContext): Promise<TicketCreationDestinationList>;
	/** @public */
	resolve(
		ctx: TicketCreationDestinationContext & {
			/** @public */
			destinationId: string;
		},
	): Promise<TicketCreationDestinationSnapshot>;
	/** Rejects stale, renamed, transferred, or otherwise invalid snapshots. @public */
	validate(snapshot: TicketCreationDestinationSnapshot): Promise<void>;
}

/** @public */
export interface TicketCreationCapability {
	/** @public */
	readonly kind: "ticket_creation";
	/** @public */
	readonly displayName: string;
	/** Extension-owned process launched by the generic derived-ticket route. @public */
	readonly processId: string;
	/** Entry turn selected when the derived process starts. @public */
	readonly startTurnId: TurnId;
	/** RFC 6901 JSON Pointer into the tool arguments. @public */
	readonly titlePath?: string;
	/** RFC 6901 JSON Pointer into the tool arguments. @public */
	readonly descriptionPath?: string;
	/** @public */
	readonly destinations?: TicketCreationDestinationProvider;
}

/** @internal */
export interface TicketCreationReceipt {
	/** @internal */
	readonly externalId: string;
	/** @internal */
	readonly url: string;
	/** @internal */
	readonly result?: unknown;
}

/** @public */
export interface IntegrationToolExecutionContext {
	/** Process-bound coordination; storage remains server-owned. */
	/** @public */
	readonly externalWrites: ExternalWrites;
	/** @public */
	readonly process: ProcessInstance;
	/** @public */
	readonly projects: readonly ProcessProject[];
	/** @public */
	readonly turn: ProcessTurnRecord;
	/** @public */
	readonly project: ProcessProject | null;
	/** @public */
	readonly ticketDestination?: TicketCreationDestinationSnapshot;
	/** Stable for a single Pi tool call, including reconnect/replay. @public */
	readonly idempotencyKey: string;
	/** Aborted when the worker stops waiting for this tool call. @public */
	readonly signal: AbortSignal;
}

/** @public */
export interface IntegrationToolDefinition<TArgs = Record<string, unknown>> {
	/** @public */
	readonly name: string;
	/** @public */
	readonly description: string;
	/** @public */
	readonly parameters: Record<string, unknown>;
	/** Sanitized discovery metadata; credentials and adapter configuration never belong here. @public */
	readonly capability?: TicketCreationCapability;
	/** @internal */
	parse?(value: unknown): TArgs;
	/** @public */
	execute(ctx: IntegrationToolExecutionContext, args: TArgs): Promise<unknown>;
}

/** @public */
export interface ServerExtensionAPI {
	/** @internal */
	readonly events: EventBus<ServerExtensionEventMap>;
	/** @public */
	readonly logger?: ServerExtensionLogger;
	/** @public */
	provide<T>(token: CapabilityToken<T>, value: T): void;
	/** @public */
	get<T>(token: CapabilityToken<T>): T | T[] | undefined;
	/** @public */
	require<T>(token: CapabilityToken<T>): T | T[];
	/** @public */
	tool<TArgs>(definition: IntegrationToolDefinition<TArgs>): void;
	/** @internal */
	onStart(handler: ExtensionLifecycleHook): void;
	/** @public */
	onStop(handler: ExtensionLifecycleHook): void;
}

/** @internal */
export interface WorkerExtensionAPI {
	/** @internal */
	readonly events: EventBus;
	/** @internal */
	get<T>(token: CapabilityToken<T>): T | T[] | undefined;
	/** @internal */
	require<T>(token: CapabilityToken<T>): T | T[];
}

/** @public */
export interface LeitwerkExtensionModule {
	/** @public */
	manifest: {
		/** @public */
		id: string;
		/** @public */
		version: string;
		/** @public */
		requires?: readonly string[];
		/** @internal */
		optional?: readonly string[];
	};
	/** Resolves every provider owned by this extension before setupServer. @public */
	modelProviders?: ModelProviderSet;
	/** @public */
	setupCatalog?(api: CatalogExtensionAPI): void | Promise<void>;
	/** @public */
	setupServer?(api: ServerExtensionAPI, config: unknown): void | Promise<void>;
	/** @internal */
	setupWorker?(api: WorkerExtensionAPI, config: unknown): void | Promise<void>;
}
