import type {
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
} from "@leitwerk-dev/domain";
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

export interface Codec<T> {
	parse(value: unknown): T;
	serialize(value: T): unknown;
}

export interface LauncherModelProfileSummary {
	readonly id: string;
	readonly provider: string;
	readonly modelId: string;
	readonly thinkingLevel: string;
}

export interface LauncherContext {
	readonly process?: ProcessInstance;
	readonly projects?: readonly ProcessProject[];
	/**
	 * Effective model profiles available to this launch path.
	 * The server may filter this list per process (for example via process allowlists)
	 * before invoking UI launcher or process watcher code.
	 */
	readonly modelProfiles?: readonly LauncherModelProfileSummary[];
}

export type LauncherVisibility = "ui";

export interface ProcessLaunchProjectConfig {
	key: string;
	repoLocator: string;
	baseBranch: string;
	workBranch?: string | null;
	externalId?: string | null;
	externalUrl?: string | null;
	metadata?: Record<string, unknown> | null;
}

export interface ProcessTitleSourceField {
	/** Short label shown to the title-generation model, e.g. "Prompt" or "Summary". */
	label: string;
	/** Launcher-selected descriptive text to summarize into a short operator-facing title. */
	value: string;
}

export interface ProcessLaunchConfig<TParams = unknown> {
	processId: string;
	params: TParams;
	startTurnId?: TurnId | null;
	/** Explicit operator-facing title. UI launches may override this with the built-in title input before persistence. */
	title?: string | null;
	/** Explicit launcher-selected fields for optional server-side title generation when title is blank. */
	titleSourceFields?: readonly ProcessTitleSourceField[];
	externalId?: string | null;
	externalUrl?: string | null;
	metadata?: Record<string, unknown> | null;
	defaultModelProfileId?: string | null;
	turnConfigs?: Record<string, { modelProfileId?: string | null }>;
	projects?: readonly ProcessLaunchProjectConfig[];
}

export type UiLauncherConfigResolution<TParams = unknown> =
	| {
			ok: true;
			launchConfig: ProcessLaunchConfig<TParams>;
	  }
	| {
			ok: false;
			errors: readonly LauncherValidationError[];
	  };

export interface UiLauncherDefinition<TParams = unknown> {
	card: LauncherCardMetadata;
	launchConfigSchema: LauncherSchemaDefinition;
	resolveDefaults?(
		ctx: LauncherContext,
	): Record<string, unknown> | Promise<Record<string, unknown>>;
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
	resolveRelaunchInput?(
		previousInput: Record<string, unknown>,
		ctx: LauncherContext,
	): Record<string, unknown> | Promise<Record<string, unknown>>;
	resolveLaunchConfig(
		input: Record<string, unknown>,
		ctx: LauncherContext,
	): UiLauncherConfigResolution<TParams> | Promise<UiLauncherConfigResolution<TParams>>;
}

export interface ProcessWatcherPresentationField {
	readonly label: string;
	readonly value: string;
	readonly format?: "text" | "code";
}

export interface ProcessWatcherPresentation {
	readonly targetSummary: string;
	readonly details?: readonly ProcessWatcherPresentationField[];
}

export interface ParsedProcessWatcherConfig<TConfig = unknown> {
	readonly config: TConfig;
	readonly enabled: boolean;
	readonly launchModelConfig?: LaunchModelConfigInput;
}

/** A watcher source is defined and owned by the extension that implements it. */
export interface ProcessWatcherSource<TConfig = unknown, TEvent = unknown> {
	readonly id: string;
	readonly label: string;
	/** Type-only marker used to carry the provider event type across the source seam. */
	readonly eventType?: TEvent;
	parseConfig(raw: unknown): ParsedProcessWatcherConfig<TConfig>;
	presentConfig(config: TConfig): ProcessWatcherPresentation;
}

export interface ProcessWatcherDefinition<TParams = unknown, TEvent = unknown, TConfig = unknown> {
	id: string;
	label: string;
	description: string;
	source: ProcessWatcherSource<TConfig, TEvent>;
	matches?(event: TEvent, ctx: LauncherContext): boolean | Promise<boolean>;
	resolveLaunchConfig(
		event: TEvent,
		ctx: LauncherContext,
	): ProcessLaunchConfig<TParams> | Promise<ProcessLaunchConfig<TParams>>;
}

export interface ProcessLauncherDefinition<TParams = unknown> {
	id: string;
	label: string;
	description: string;
	visibility: LauncherVisibility;
	ui: UiLauncherDefinition<TParams>;
}

export interface ProcessLaunchPlanProcessInput extends ProcessCustomizableFields {
	processId: string;
	selectedTurnId: string | null;
	lifecycleStatus: ProcessLifecycleStatus;
	paramsJson: string | null;
	stateJson: string | null;
}

export interface ProcessLaunchPlan {
	launcherId: string;
	processId: string;
	processInput: ProcessLaunchPlanProcessInput;
	/** Optional server-owned idempotency key for cross-process handoffs. */
	handoffDedupKey?: string | null;
	/** Carry-forward launcher-selected fields for optional server-side title generation. */
	titleSourceFields?: readonly ProcessTitleSourceField[];
	projectInputs: readonly ProcessLaunchProjectConfig[];
	startTurnId: TurnId | null;
}

export interface ResolvedProcessLauncher<TParams = unknown> {
	launcherId: string;
	processId: string;
	displayName: string;
	launchConfig: ProcessLaunchConfig<TParams>;
	launchPlan: ProcessLaunchPlan;
}

export type UiLauncherResolutionResult<TParams = unknown> =
	| {
			ok: true;
			launcher: ResolvedProcessLauncher<TParams>;
	  }
	| {
			ok: false;
			errors: readonly LauncherValidationError[];
	  };

export interface UiLauncherSummary extends UiLauncherSummaryBase {}

export interface ProcessLauncherService {
	listUiLaunchers(): readonly UiLauncherSummary[];
	resolveUiDefaults(launcherId: string, ctx?: LauncherContext): Promise<Record<string, unknown>>;
	resolveUiOptions(
		launcherId: string,
		input: Record<string, unknown>,
		ctx?: LauncherContext,
	): Promise<Record<string, readonly LauncherFieldOptionDefinition[]>>;
	resolveUiRelaunchInput(
		launcherId: string,
		previousInput: Record<string, unknown>,
		ctx?: LauncherContext,
	): Promise<Record<string, unknown>>;
	resolveUiLauncher(
		launcherId: string,
		input: Record<string, unknown>,
		ctx?: LauncherContext,
	): Promise<UiLauncherResolutionResult>;
}

/** Resolve a UI launcher summary by id, returning `null` when it is unknown. */
export function findUiLauncherById(
	launcherService: Pick<ProcessLauncherService, "listUiLaunchers">,
	launcherId: string,
): UiLauncherSummary | null {
	return launcherService.listUiLaunchers().find((launcher) => launcher.id === launcherId) ?? null;
}

export interface ProcessTurnOutcomeEvent {
	turnRecordId: string;
	turnId: string;
	outcome: string;
	params: Record<string, unknown>;
	turnResultMarkdown?: string | null;
}

export type ProcessCleanupReason = "abort";

export interface ProcessCleanupResult<TState = unknown> extends ProcessLifecycleEffects {
	state?: TState;
}

export interface ProcessCleanupContext<TParams = unknown, TState = unknown>
	extends ProcessSnapshotContext<TParams, TState> {
	readonly reason: ProcessCleanupReason;
}

export type ProcessCleanupHandler<TParams = unknown, TState = unknown> = (
	ctx: ProcessCleanupContext<TParams, TState>,
) => undefined | ProcessCleanupResult<TState> | Promise<ProcessCleanupResult<TState> | undefined>;

export interface LeafOutcomeCaptureContext<TParams = unknown, TState = unknown>
	extends ProcessSnapshotContext<TParams, TState> {
	readonly leaf: {
		entryId: string;
		turnRecordId: string | null;
	};
	readonly turnRecord: ProcessTurnRecord | null;
	readTreeEntry(entryId: string): PiTreeEntry | null;
	readLeafEntry(): PiTreeEntry | null;
	readTurnRecord(turnRecordId: string): ProcessTurnRecord | null;
}

export interface LeafOutcomeCaptureResult {
	rendererId: string;
	schemaVersion?: number;
	props: Record<string, unknown>;
	fallbackMarkdown?: string | null;
}

export interface ProcessLeafOutcomeDefinition<TParams = unknown, TState = unknown> {
	rendererId: string;
	capture(
		ctx: LeafOutcomeCaptureContext<TParams, TState>,
	): Promise<LeafOutcomeCaptureResult | null> | LeafOutcomeCaptureResult | null;
}

export interface ProcessActionDefinition<TParams = unknown, TState = unknown> {
	id: string;
	label: string;
	form?: FormDefinition;
	preview?: ProcessActionPreviewDefinition;
	scheduling?: ProcessActionSchedulingDefinition;
	/**
	 * Explicitly marks an action as an immediate-only side-effect command. Such
	 * actions must declare execute(...), cannot participate in pure preview or
	 * scheduling flows, and are run only by immediate action execution.
	 */
	executionMode?: "side_effect";
	/**
	 * Optional pure planner used for side-effect-free previews, scheduling validation,
	 * and immediate execution. The shared server runtime collects the declared
	 * transition/input/event plan from this hook without committing side effects
	 * while the hook runs.
	 */
	plan?(input: Record<string, unknown>, ctx: ServerProcessContext<TParams, TState>): Promise<void>;
	/**
	 * Imperative hook for actions with executionMode: "side_effect". Use only for
	 * immediate side effects that cannot be represented as a pure plan(...).
	 */
	execute?(
		input: Record<string, unknown>,
		ctx: ServerProcessContext<TParams, TState>,
	): Promise<void>;
}

export type ServerTransitionRuntime = "reconcile" | "restart_worker";

export interface ServerTransitionEffect {
	/**
	 * Declares how the server runtime should handle the worker context after the
	 * durable transition is committed.
	 */
	runtime?: ServerTransitionRuntime;
}

export interface ServerTransitionRequest<TState = unknown> {
	lifecycleStatus?: ProcessLifecycleStatus;
	turnId?: TurnId | null;
	state?: TState;
	/** State machine trigger for the selected-turn graph. */
	trigger?: string;
	effect?: ServerTransitionEffect;
}

export interface ProcessSnapshotContext<TParams = unknown, TState = unknown> {
	readonly process: ProcessInstance;
	readonly projects: readonly ProcessProject[];
	readonly params: TParams;
	readonly state: TState;
}

export type ExternalSourceInputMode = "none" | "input" | "instruction";

export interface ExternalSourceResolveContext<TParams = unknown, TState = unknown>
	extends ProcessSnapshotContext<TParams, TState> {}

export interface ExternalSourceEffectContext<
	TParams = unknown,
	TState = unknown,
	TEvent = unknown,
	TInput extends Record<string, unknown> = Record<string, unknown>,
> extends ProcessSnapshotContext<TParams, TState> {
	readonly event: TEvent;
	readonly input: TInput;
}

export type ExternalSourceEffect<
	TParams = unknown,
	TState = unknown,
	TEvent = unknown,
	TInput extends Record<string, unknown> = Record<string, unknown>,
> = (
	ctx: ExternalSourceEffectContext<TParams, TState, TEvent, TInput>,
) => ProcessEffectPlan<TState> | Promise<ProcessEffectPlan<TState> | undefined> | undefined;

export interface ExternalActionSource<
	TParams = unknown,
	TState = unknown,
	_TEvent = unknown,
	_TInput extends Record<string, unknown> = Record<string, unknown>,
> {
	kind: string;
	label?: string;
	description?: string;
	/**
	 * Extension-owned opaque config. Core may persist, hash, and display it, but must not
	 * interpret provider-specific fields.
	 */
	config: unknown;
	/** Source-provided input behavior. Provider input is only published when the external action declares publishInput. */
	inputMode?: ExternalSourceInputMode;
	/** Optional extension-owned resolver for process-instance-specific matching. */
	resolve?(ctx: ExternalSourceResolveContext<TParams, TState>): unknown;
}

export interface ServerProcessContext<TParams = unknown, TState = unknown>
	extends ProcessSnapshotContext<TParams, TState> {
	transition(next: ServerTransitionRequest<TState>): Promise<void>;
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
	readSemanticTurnResultMarkdown(ref: ProcessSemanticEntryRefKey): string | null;
	/**
	 * Resolves non-empty turn-result markdown for a process-defined published product.
	 * Returns `null` when the product ref is unset or the referenced turn result does
	 * not carry operator-facing markdown. Throws when persisted product-ref state is
	 * malformed.
	 */
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
	queueInput(input: {
		source: InputSource;
		kind: InputKind;
		bodyMarkdown: string;
		target?: ProcessInputTarget;
	}): void;
	/**
	 * Internal SDK lifecycle-effect collector used by high-level process authoring
	 * helpers. Raw process definitions should prefer intent helpers instead of
	 * constructing these effects directly.
	 */
	applyLifecycleEffects?(effects: ProcessLifecycleEffects): void;
}

export interface WorkerProcessContext<TParams = unknown, TState = unknown>
	extends ProcessSnapshotContext<TParams, TState> {
	readonly turnResultMarkdownBySemanticRef?: Partial<Record<ProcessSemanticEntryRefKey, string>>;
	readonly turnResultMarkdownByProduct?: Readonly<Record<string, string>>;
	/** Absolute workspace root for the current process instance, when available. */
	readonly workspaceRoot?: string;
}

export interface WorkerCompleteInput<TOutcome extends string = string> {
	outcome: TOutcome;
	params?: Record<string, unknown>;
	markdown?: string | null;
}

export interface WorkerRunHandle<TParams = unknown, TState = unknown> {
	readonly ctx: WorkerProcessContext<TParams, TState>;
	turn<TOutcome extends string>(
		def: LlmTurnDefinition<TOutcome, TParams, TState>,
		options?: TurnOptions,
	): Promise<{ outcome: TOutcome; params: Record<string, unknown> }>;
	complete<TOutcome extends string>(input: WorkerCompleteInput<TOutcome>): Promise<void>;
	park(reason?: string): void;
}

export type WorkerTurnHandler<TParams = unknown, TState = unknown> = (
	run: WorkerRunHandle<TParams, TState>,
) => Promise<void>;

export interface ServerProcessAPI<TParams = unknown, TState = unknown> {
	action(def: ProcessActionDefinition<TParams, TState>): void;
	onTurnOutcome(
		turnId: string,
		handler: (
			event: ProcessTurnOutcomeEvent,
			ctx: ServerProcessContext<TParams, TState>,
		) => void | Promise<void>,
	): void;
	onCleanup(handler: ProcessCleanupHandler<TParams, TState>): void;
}

export interface WorkerProcessAPI<TParams = unknown, TState = unknown> {
	start(turnId: TurnId): void;
	turn(turnId: TurnId, handler: WorkerTurnHandler<TParams, TState>): void;
}

export interface UiProcessAPI<TParams = unknown, TState = unknown> {
	leafOutcome(def: ProcessLeafOutcomeDefinition<TParams, TState>): void;
}

export interface ProcessLauncherAPI<TParams = unknown> {
	launcher(def: ProcessLauncherDefinition<TParams>): void;
}

export interface ProcessWatcherAPI<TParams = unknown> {
	watcher<TEvent = unknown, TConfig = unknown>(
		def: ProcessWatcherDefinition<TParams, TEvent, TConfig>,
	): void;
}

export interface ProcessTurnBinding<TTurn = TurnDefinition> {
	definition: TTurn;
}

export type RepositoryCredentialKind = "git_ssh";

/** Non-secret, code-defined repository authentication request. */
export interface RepositoryCredentialRequirement {
	readonly projectKey: string;
	readonly kind: RepositoryCredentialKind;
	readonly credentialRef: string;
}

/** Project fields available while deriving repository credential requirements. */
export interface RepositoryCredentialProject {
	readonly key: string;
	readonly repoLocator: string;
	readonly baseBranch: string;
	readonly workBranch: string | null;
}

/** Secret material is intentionally restricted to server registration and worker.start. */
export interface GitSshCredentialMaterial {
	readonly privateKey: string;
	readonly knownHosts: string;
}

export interface RepositoryCredentialProvider {
	readonly kind: RepositoryCredentialKind;
	resolve(credentialRef: string): GitSshCredentialMaterial | null;
}

export interface RepositoryCredentialRegistrar {
	register(provider: RepositoryCredentialProvider): void;
}

export interface ExtensionProcessDefinition<TParams = unknown, TState = unknown> {
	id: string;
	displayName: string;
	/** Primary entry used when a launch does not select a start turn explicitly. */
	entryTurnId: TurnId;
	/** Additional entry turns that launchers may select explicitly. */
	alternateEntryTurnIds?: readonly TurnId[];
	/**
	 * Optional author-declared happy path: the ordered spine of turns a successful
	 * run walks through. Flow diagrams render this as the main line and hang every
	 * other turn off it as a branch. When omitted, consumers fall back to a derived
	 * best-effort spine.
	 */
	happyPath?: readonly TurnId[];
	turns: ReadonlyMap<TurnId, ProcessTurnBinding<TurnDefinition<TParams, TState>>>;
	paramsCodec: Codec<TParams>;
	stateCodec: Codec<TState>;
	initialState(params: TParams): TState;
	/** Runtime-only requirements; references are non-secret and remain in opaque params JSON. */
	repositoryCredentials?(input: {
		params: TParams;
		projects: readonly RepositoryCredentialProject[];
	}): readonly RepositoryCredentialRequirement[];
	piConfig?: ProcessPiConfig;
	server?: (api: ServerProcessAPI<TParams, TState>) => void;
	worker?: (api: WorkerProcessAPI<TParams, TState>) => void;
	ui?: (api: UiProcessAPI<TParams, TState>) => void;
	launchers?: (api: ProcessLauncherAPI<TParams>) => void;
	watchers?: (api: ProcessWatcherAPI<TParams>) => void;
}

export interface CatalogExtensionAPI {
	readonly events: EventBus;
	registerProcess<TParams = unknown, TState = unknown>(
		def: ExtensionProcessDefinition<TParams, TState>,
	): void;
	registerToolRenderer(def: ToolCallRendererDefinition): void;
	provide<T>(token: CapabilityToken<T>, value: T): void;
	get<T>(token: CapabilityToken<T>): T | T[] | undefined;
	require<T>(token: CapabilityToken<T>): T | T[];
}

export type ExtensionLifecycleHook = () => void | Promise<void>;

export interface ServerExtensionLogger {
	info?(payload: Record<string, unknown>, message?: string): void;
	warn?(payload: Record<string, unknown>, message?: string): void;
	error?(payload: Record<string, unknown>, message?: string): void;
}

export interface IntegrationToolExecutionContext {
	readonly process: ProcessInstance;
	readonly projects: readonly ProcessProject[];
	readonly turn: ProcessTurnRecord;
	readonly project: ProcessProject | null;
	/** Stable for a single Pi tool call, including reconnect/replay. */
	readonly idempotencyKey: string;
}

export interface IntegrationToolDefinition<TArgs = Record<string, unknown>> {
	readonly name: string;
	readonly description: string;
	readonly parameters: Record<string, unknown>;
	parse?(value: unknown): TArgs;
	execute(ctx: IntegrationToolExecutionContext, args: TArgs): Promise<unknown>;
}

export interface ServerExtensionAPI {
	readonly events: EventBus<ServerExtensionEventMap>;
	readonly logger?: ServerExtensionLogger;
	provide<T>(token: CapabilityToken<T>, value: T): void;
	get<T>(token: CapabilityToken<T>): T | T[] | undefined;
	require<T>(token: CapabilityToken<T>): T | T[];
	tool<TArgs>(definition: IntegrationToolDefinition<TArgs>): void;
	onStart(handler: ExtensionLifecycleHook): void;
	onStop(handler: ExtensionLifecycleHook): void;
}

export interface WorkerExtensionAPI {
	readonly events: EventBus;
	get<T>(token: CapabilityToken<T>): T | T[] | undefined;
	require<T>(token: CapabilityToken<T>): T | T[];
}

export interface LeitwerkExtensionManifest {
	id: string;
	version: string;
	requires?: readonly string[];
	optional?: readonly string[];
}

export interface LeitwerkExtensionModule {
	manifest: LeitwerkExtensionManifest;
	/** Resolves every provider owned by this extension before setupServer. */
	modelProviders?: ModelProviderSet;
	setupCatalog?(api: CatalogExtensionAPI): void | Promise<void>;
	setupServer?(api: ServerExtensionAPI, config: unknown): void | Promise<void>;
	setupWorker?(api: WorkerExtensionAPI, config: unknown): void | Promise<void>;
}
