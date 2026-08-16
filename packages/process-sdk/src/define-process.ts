import {
	assertValidProcessProductName,
	type InputKind,
	type InputSource,
	type ProcessInputTarget,
	type ProcessInstance,
	type ProcessSemanticEntryRefKey,
	type ProcessTurnStartSelection,
	type ProcessTurnTerminalLifecycleStatus,
	type ProcessTurnTransition,
	type ReviewSubject,
	type TurnId,
} from "@leitwerk-dev/domain";
import type {
	Codec,
	ExtensionProcessDefinition,
	ExternalActionSource,
	ExternalSourceEffect,
	FormDefinition,
	ProcessLauncherAPI,
	ProcessTurnBinding,
	ProcessTurnOutcomeEvent,
	ProcessWatcherAPI,
	RepositoryCredentialProject,
	RepositoryCredentialRequirement,
	ServerProcessAPI,
	ServerProcessContext,
	ServerTransitionRequest,
	UiProcessAPI,
	WorkerCompleteInput,
	WorkerProcessAPI,
	WorkerProcessContext,
} from "./extension-api.js";
import {
	getProcessTurnTransitions,
	markDefinedProcess,
	setProcessTurnTransitions,
} from "./process-definition-internals.js";
import type { ServerExtensionEventMap } from "./server-events.js";
import type {
	HumanTurnActionView,
	HumanTurnExternalActionView,
	HumanTurnExternalTrigger,
	HumanTurnNotesField,
	OutcomeToolParameterSpec,
	PiBuiltInToolName,
	ProcessActionPreviewDefinition,
	ProcessActionSchedulingDefinition,
	ProcessPiConfig,
	TurnAcceptanceState,
	TurnBranchType,
	TurnCompletionMode,
	TurnContextMode,
	TurnResultMarkdownBehavior,
} from "./types.js";

type ProcessEventName = keyof ServerExtensionEventMap & string;

type ProcessEmittedEvent = {
	type: ProcessEventName;
	data: unknown;
};

type ProcessQueuedInput = {
	source: InputSource;
	kind: InputKind;
	bodyMarkdown: string;
	target?: ProcessInputTarget;
};

type MaybePromise<T> = T | Promise<T>;

type StaticRouteTarget = {
	to?: TurnId;
	complete?: boolean;
	lifecycleStatus?: ProcessTurnTerminalLifecycleStatus;
};

type NormalizedRouteTarget = {
	nextTurnId?: TurnId;
	lifecycleStatus?: ProcessTurnTerminalLifecycleStatus;
};

type NormalizedActionRoute = NormalizedRouteTarget & {
	trigger: string;
};

export interface ProcessRuntimeTurnContext<TParams = unknown, TState = unknown>
	extends WorkerProcessContext<TParams, TState> {}

export interface ProcessServerRuntimeContext<TParams = unknown, TState = unknown> {
	readonly process: ServerProcessContext<TParams, TState>["process"];
	readonly projects: ServerProcessContext<TParams, TState>["projects"];
	readonly params: TParams;
	readonly state: TState;
	readSemanticTurnResultMarkdown(ref: ProcessSemanticEntryRefKey): string | null;
	readProductTurnResultMarkdown(productName: string): string | null;
}

export interface ProcessBroadcastEffect {
	type: string;
	payload: Record<string, unknown>;
}

export type ProcessPatchEffect = Partial<
	Pick<
		ProcessInstance,
		| "lifecycleStatus"
		| "planRevision"
		| "title"
		| "externalId"
		| "externalUrl"
		| "metadata"
		| "defaultModelProfileId"
		| "turnConfigsJson"
	>
>;

export interface ProcessLifecycleEffects {
	processPatch?: ProcessPatchEffect;
	broadcasts?: readonly ProcessBroadcastEffect[];
}

export interface ProcessEffectPlan<TState = unknown> extends ProcessLifecycleEffects {
	state?: TState;
	emit?: readonly ProcessEmittedEvent[];
	queueInput?: readonly ProcessQueuedInput[];
}

export interface SavePlanResultLifecycleIntent<TParams = unknown, TState = unknown> {
	kind: "save_plan_result";
	summaryParam: string;
	acceptanceCriteriaParam: string;
	planMarkdownParam: string;
	emitEventType: ProcessEventName;
	broadcastType: string;
	state?: ProcessOutcomeEffect<TParams, TState>;
}

export type ProcessOutcomeLifecycleIntent<
	TParams = unknown,
	TState = unknown,
> = SavePlanResultLifecycleIntent<TParams, TState>;

export interface ProcessActionExecution<TParams = unknown, TState = unknown> {
	readonly ctx: ProcessServerRuntimeContext<TParams, TState>;
	readonly input: Record<string, unknown>;
	readonly turnId: TurnId;
	readonly actionId: string;
	readonly selectedBranchId?: string;
}

export interface ProcessOutcomeExecution<TParams = unknown, TState = unknown> {
	readonly ctx: ProcessServerRuntimeContext<TParams, TState>;
	readonly event: ProcessTurnOutcomeEvent;
	readonly turnId: TurnId;
	readonly outcome: string;
}

export type ProcessActionEffect<TParams = unknown, TState = unknown> = (
	input: ProcessActionExecution<TParams, TState>,
) => MaybePromise<ProcessEffectPlan<TState> | undefined>;

export type ProcessActionBranchSelector<TParams = unknown, TState = unknown> = (
	input: Omit<ProcessActionExecution<TParams, TState>, "selectedBranchId">,
) => MaybePromise<string>;

export type ProcessOutcomeEffect<TParams = unknown, TState = unknown> = (
	input: ProcessOutcomeExecution<TParams, TState>,
) => MaybePromise<ProcessEffectPlan<TState> | undefined>;

export interface ProcessActionExternalTrigger {
	id: string;
	label: string;
	description: string;
}

export interface ExternalActionInputPublication {
	productName: string;
	inputField: string;
}

export interface ProcessHumanTurnExternalActionSpec<
	TParams = unknown,
	TState = unknown,
	TEvent = unknown,
	TInput extends Record<string, unknown> = Record<string, unknown>,
> extends StaticRouteTarget {
	id: string;
	source: ExternalActionSource<TParams, TState, TEvent, TInput>;
	label?: string;
	description?: string;
	publishInput?: ExternalActionInputPublication;
	effect?: ExternalSourceEffect<TParams, TState, TEvent, TInput>;
}

export interface ProcessActionBranchSpec extends StaticRouteTarget {
	trigger?: string;
}

type StaticActionRouting = StaticRouteTarget & {
	trigger?: string;
};

type BranchingActionRouting<TParams, TState> = {
	branches: Record<string, ProcessActionBranchSpec>;
	choose: ProcessActionBranchSelector<TParams, TState>;
};

interface BaseActionSpec<TParams, TState> {
	label: string;
	description?: string;
	form?: FormDefinition;
	preview?: ProcessActionPreviewDefinition;
	schedulable?: boolean;
	effect?: ProcessActionEffect<TParams, TState>;
}

export type ProcessHumanTurnActionSpec<TParams = unknown, TState = unknown> = BaseActionSpec<
	TParams,
	TState
> & {
	acceptanceState: TurnAcceptanceState;
	externalTriggers?: readonly ProcessActionExternalTrigger[];
} & (StaticActionRouting | BranchingActionRouting<TParams, TState>);

export interface ProcessToolOutcomeSpec<TParams = unknown, TState = unknown>
	extends StaticRouteTarget {
	description: string;
	parameters: Record<string, OutcomeToolParameterSpec>;
	/** Product published from this outcome's turn-result markdown, when this outcome is selected. */
	publishedProduct?: string;
	/** Outcome parameter whose markdown value is captured as the turn result. */
	turnResultMarkdownParameter?: string;
	effect?: ProcessOutcomeEffect<TParams, TState>;
	lifecycleIntent?: ProcessOutcomeLifecycleIntent<TParams, TState>;
}
export type HumanTurnOperatorAttention = "required" | "passive";

export interface HumanTurnDefinition<TParams = unknown, TState = unknown> {
	kind: "human";
	description: string;
	/** Optional for generic operator-waiting turns; review turns should set it. */
	reviewSubject?: ReviewSubject;
	reviewProduct?: string;
	reviewSemanticRef?: ProcessSemanticEntryRefKey;
	/** Controls whether entering this turn should raise an action-required toast. */
	operatorAttention?: HumanTurnOperatorAttention;
	notesFields?: readonly HumanTurnNotesField[];
	commentary?: string;
	actions: Record<string, ProcessHumanTurnActionSpec<TParams, TState>>;
	externalActions?: Record<string, ProcessHumanTurnExternalActionSpec<TParams, TState>>;
}

export interface ProcessTurnEndSpec<
	TParams = unknown,
	TState = unknown,
	TOutcome extends string = string,
> extends StaticRouteTarget {
	outcome: TOutcome;
	params?: Record<string, unknown>;
	effect?: ProcessOutcomeEffect<TParams, TState>;
}

export type OutcomeRouteSpec<TParams = unknown, TState = unknown> = StaticRouteTarget &
	Partial<Pick<ProcessToolOutcomeSpec<TParams, TState>, "description" | "parameters" | "effect">>;

export interface OutcomeRouteOptions {
	strict?: boolean;
}

export type LlmModelPurpose = "process_title_generation";

export interface LlmTurnDefinition<
	TOutcome extends string = string,
	TParams = unknown,
	TState = unknown,
> {
	kind: "llm";
	description: string;
	/** Code-defined model policy purpose. Purpose selections cannot be overridden per launch/action. */
	modelPurpose?: LlmModelPurpose;
	/** Built-in Pi tools active while this turn runs. */
	availableTools: readonly PiBuiltInToolName[];
	/** Server-owned integration tools proxied over authenticated worker IPC. */
	integrationTools?: readonly string[];
	/** Opt in to the durable, operator-facing ask_questions custom tool. */
	askQuestions?: boolean;
	completionMode?: TurnCompletionMode;
	branchType: TurnBranchType;
	context: TurnContextMode;
	startFrom?: ProcessTurnStartSelection;
	restorePrimaryLeafAfterTurn?: boolean;
	prompt(ctx: ProcessRuntimeTurnContext<TParams, TState>): string | Promise<string>;
	outcomes?: Partial<Record<TOutcome, ProcessToolOutcomeSpec<TParams, TState>>>;
	turnEnd?: ProcessTurnEndSpec<TParams, TState, TOutcome>;
	turnResultMarkdown?: TurnResultMarkdownBehavior;
	reviewSubject?: ReviewSubject;
	reviewSemanticRef?: ProcessSemanticEntryRefKey;
	resultSemanticRef?: ProcessSemanticEntryRefKey;
	publishedProduct?: string;
	consumedProducts?: readonly string[];
	optionalConsumedProducts?: readonly string[];
	requiredSemanticMarkdownRefs?: readonly ProcessSemanticEntryRefKey[];
	optionalSemanticMarkdownRefs?: readonly ProcessSemanticEntryRefKey[];
}

export interface AutomaticTurnDefinition<
	TOutcome extends string = string,
	TParams = unknown,
	TState = unknown,
> {
	kind: "automatic";
	description: string;
	/** Server-owned integration tools callable by this deterministic worker turn. */
	integrationTools?: readonly string[];
	/** External events armed while this automatic turn is selected and waiting. */
	externalActions?: Record<string, ProcessHumanTurnExternalActionSpec<TParams, TState>>;
	outcomes?: Partial<Record<TOutcome, ProcessToolOutcomeSpec<TParams, TState>>>;
	turnEnd?: ProcessTurnEndSpec<TParams, TState, TOutcome>;
	reviewSubject?: ReviewSubject;
	reviewSemanticRef?: ProcessSemanticEntryRefKey;
	run(
		ctx: ProcessRuntimeTurnContext<TParams, TState>,
	): Promise<WorkerCompleteInput<TOutcome>> | WorkerCompleteInput<TOutcome>;
}

export interface ServerAutomaticTurnRunResult<TOutcome extends string = string, TState = unknown>
	extends WorkerCompleteInput<TOutcome> {
	state?: TState;
}

export type ServerAutomaticTurnRestartBehavior = "rerun" | "fail_running";

export interface ServerAutomaticTurnDefinition<
	TOutcome extends string = string,
	TParams = unknown,
	TState = unknown,
> {
	kind: "server_automatic";
	description: string;
	outcomes?: Partial<Record<TOutcome, ProcessToolOutcomeSpec<TParams, TState>>>;
	turnEnd?: ProcessTurnEndSpec<TParams, TState, TOutcome>;
	reviewSubject?: ReviewSubject;
	reviewSemanticRef?: ProcessSemanticEntryRefKey;
	/**
	 * Controls startup/drainer behavior when a durable running turn record already exists.
	 * The default reruns the deterministic handler. Use fail_running for non-idempotent
	 * host side effects that must not be replayed after a server crash/restart.
	 */
	restartBehavior?: ServerAutomaticTurnRestartBehavior;
	run(
		ctx: ProcessServerRuntimeContext<TParams, TState>,
	):
		| Promise<ServerAutomaticTurnRunResult<TOutcome, TState>>
		| ServerAutomaticTurnRunResult<TOutcome, TState>;
}

export interface ExternalSourceTransition<
	TParams = unknown,
	TState = unknown,
	TEvent = unknown,
	TInput extends Record<string, unknown> = Record<string, unknown>,
> extends StaticRouteTarget {
	source: ExternalActionSource<TParams, TState, TEvent, TInput>;
	effect?: ExternalSourceEffect<TParams, TState, TEvent, TInput>;
}

export interface ExternalTurnDefinition<TParams = unknown, TState = unknown> {
	kind: "external";
	description: string;
	transitions: readonly ExternalSourceTransition<TParams, TState>[];
	reviewSubject?: ReviewSubject;
	reviewSemanticRef?: ProcessSemanticEntryRefKey;
}

export type TurnDefinition<TParams = unknown, TState = unknown> =
	| LlmTurnDefinition<string, TParams, TState>
	| AutomaticTurnDefinition<string, TParams, TState>
	| ServerAutomaticTurnDefinition<string, TParams, TState>
	| HumanTurnDefinition<TParams, TState>
	| ExternalTurnDefinition<TParams, TState>;

export type TurnDefinitionRecord<TParams = unknown, TState = unknown> = Record<
	TurnId,
	TurnDefinition<TParams, TState>
>;

export type ProcessDefinition<TParams = unknown, TState = unknown> = ExtensionProcessDefinition<
	TParams,
	TState
>;

export interface DefinedProcessInput<TParams = unknown, TState = unknown> {
	id: string;
	displayName: string;
	/** Primary entry used when a launch does not select a start turn explicitly. */
	entry: TurnId;
	/** Additional entry turns that launchers may select explicitly. */
	alternateEntries?: readonly TurnId[];
	happyPath?: readonly TurnId[];
	paramsCodec: Codec<TParams>;
	stateCodec: Codec<TState>;
	initialState(params: TParams): TState;
	repositoryCredentials?(input: {
		params: TParams;
		projects: readonly RepositoryCredentialProject[];
	}): readonly RepositoryCredentialRequirement[];
	piConfig?: ProcessPiConfig;
	turns: TurnDefinitionRecord<TParams, TState>;
	worker?: (api: WorkerProcessAPI<TParams, TState>) => void;
	server?: (api: ServerProcessAPI<TParams, TState>) => void;
	ui?: (api: UiProcessAPI<TParams, TState>) => void;
	launchers?: (api: ProcessLauncherAPI<TParams>) => void;
	watchers?: (api: ProcessWatcherAPI<TParams>) => void;
}

type CompiledActionRouting<TParams, TState> =
	| {
			kind: "static";
			route: NormalizedActionRoute;
	  }
	| {
			kind: "branches";
			routes: Record<string, NormalizedActionRoute>;
			choose: ProcessActionBranchSelector<TParams, TState>;
	  };

type CompiledActionUse<TParams, TState> = {
	turnId: TurnId;
	label?: string;
	form?: FormDefinition;
	effect?: ProcessActionEffect<TParams, TState>;
	routing: CompiledActionRouting<TParams, TState>;
};

type CompiledExecutableTurn<TParams, TState> =
	| {
			kind: "llm";
			id: TurnId;
			spec: LlmTurnDefinition<string, TParams, TState>;
	  }
	| {
			kind: "automatic";
			id: TurnId;
			spec: AutomaticTurnDefinition<string, TParams, TState>;
	  };

function createTransitionTargetError(context: string, detail: string): Error {
	return new Error(`${context} ${detail}`);
}

function createProcessTurnBinding<TTurn>(
	definition: TTurn,
	transitions?: readonly ProcessTurnTransition[],
): ProcessTurnBinding<TTurn> {
	const binding: ProcessTurnBinding<TTurn> = { definition };
	if (transitions && transitions.length > 0) {
		setProcessTurnTransitions(binding, transitions);
	}
	return binding;
}

function normalizeStaticRouteTarget(
	context: string,
	target: StaticRouteTarget,
	knownTurnIds?: ReadonlySet<TurnId>,
): NormalizedRouteTarget {
	const declaredTargetCount =
		(target.to !== undefined ? 1 : 0) +
		(target.complete === true ? 1 : 0) +
		(target.lifecycleStatus !== undefined ? 1 : 0);
	if (declaredTargetCount !== 1) {
		throw createTransitionTargetError(
			context,
			"must declare exactly one target via 'to', 'complete', or 'lifecycleStatus'",
		);
	}
	if (target.to !== undefined) {
		if (knownTurnIds && !knownTurnIds.has(target.to)) {
			throw createTransitionTargetError(context, `references unknown turn '${target.to}'`);
		}
		return { nextTurnId: target.to };
	}
	if (target.complete === true) {
		return { lifecycleStatus: "completed" };
	}
	return { lifecycleStatus: target.lifecycleStatus };
}

function buildOutcomeTransition<TParams, TState>(
	turnId: TurnId,
	outcome: string,
	target: ProcessToolOutcomeSpec<TParams, TState> | ProcessTurnEndSpec<TParams, TState>,
	knownTurnIds?: ReadonlySet<TurnId>,
): NormalizedRouteTarget {
	if (!hasDeclaredStaticRouteTarget(target)) {
		return { nextTurnId: turnId };
	}
	return normalizeStaticRouteTarget(`Turn '${turnId}' outcome '${outcome}'`, target, knownTurnIds);
}

function resolveActionRouting<TParams, TState>(input: {
	turnId: TurnId;
	actionId: string;
	spec: ProcessHumanTurnActionSpec<TParams, TState>;
	knownTurnIds?: ReadonlySet<TurnId>;
}): {
	routing: CompiledActionRouting<TParams, TState>;
	transitions: readonly NormalizedActionRoute[];
} {
	if ("branches" in input.spec) {
		const entries = Object.entries(input.spec.branches) as Array<[string, ProcessActionBranchSpec]>;
		if (entries.length === 0) {
			throw new Error(
				`Action '${input.actionId}' on turn '${input.turnId}' must declare at least one branch`,
			);
		}
		const routes: Record<string, NormalizedActionRoute> = {};
		const resolvedTransitions: NormalizedActionRoute[] = [];
		const usedTriggers = new Set<string>();
		for (const [branchId, branchSpec] of entries) {
			if (branchId.trim() === "") {
				throw new Error(
					`Action '${input.actionId}' on turn '${input.turnId}' contains an empty branch id`,
				);
			}
			const target = normalizeStaticRouteTarget(
				`Action '${input.actionId}' branch '${branchId}' on turn '${input.turnId}'`,
				branchSpec,
				input.knownTurnIds,
			);
			const trigger = branchSpec.trigger ?? branchId;
			if (usedTriggers.has(trigger)) {
				throw new Error(
					`Action '${input.actionId}' on turn '${input.turnId}' contains duplicate branch trigger '${trigger}'`,
				);
			}
			usedTriggers.add(trigger);
			const normalized = {
				...(target.nextTurnId ? { nextTurnId: target.nextTurnId } : {}),
				...(target.lifecycleStatus ? { lifecycleStatus: target.lifecycleStatus } : {}),
				trigger,
			};
			routes[branchId] = normalized;
			resolvedTransitions.push(normalized);
		}
		return {
			routing: {
				kind: "branches",
				routes,
				choose: input.spec.choose,
			},
			transitions: resolvedTransitions,
		};
	}
	const target = normalizeStaticRouteTarget(
		`Action '${input.actionId}' on turn '${input.turnId}'`,
		input.spec,
		input.knownTurnIds,
	);
	const route = {
		...(target.nextTurnId ? { nextTurnId: target.nextTurnId } : {}),
		...(target.lifecycleStatus ? { lifecycleStatus: target.lifecycleStatus } : {}),
		trigger: input.spec.trigger ?? input.actionId,
	};
	return {
		routing: {
			kind: "static",
			route,
		},
		transitions: [route],
	};
}

function externalSourceTransitionId(input: {
	turnId: TurnId;
	source: ExternalActionSource;
	index: number;
}): string {
	return `${input.turnId}:${input.source.kind}:${input.index}`;
}

function externalActionArmingId(input: { turnId: TurnId; externalActionId: string }): string {
	return `${input.turnId}:${input.externalActionId}`;
}

function externalActionTransitionTrigger(input: { externalActionId: string }): string {
	return `external:${input.externalActionId}`;
}

function compileExternalSourceTransitions<TParams, TState>(input: {
	turnId: TurnId;
	spec: ExternalTurnDefinition<TParams, TState>;
	knownTurnIds: ReadonlySet<TurnId>;
}): readonly ProcessTurnTransition[] {
	if (input.spec.transitions.length === 0) {
		throw new Error(`External turn '${input.turnId}' must declare at least one source transition`);
	}
	return input.spec.transitions.map((transition, index) => {
		if (transition.source.kind.trim() === "") {
			throw new Error(
				`External turn '${input.turnId}' source transition ${index} has an empty kind`,
			);
		}
		const target = normalizeStaticRouteTarget(
			`External turn '${input.turnId}' source '${transition.source.kind}'`,
			transition,
			input.knownTurnIds,
		);
		return {
			...(target.nextTurnId ? { nextTurnId: target.nextTurnId } : {}),
			...(target.lifecycleStatus ? { lifecycleStatus: target.lifecycleStatus } : {}),
			trigger: externalSourceTransitionId({
				turnId: input.turnId,
				source: transition.source,
				index,
			}),
		};
	});
}

export function getExternalSourceTransitionId(input: {
	turnId: TurnId;
	source: ExternalActionSource;
	index: number;
}): string {
	return externalSourceTransitionId(input);
}

export function getExternalActionArmingId(input: {
	turnId: TurnId;
	externalActionId: string;
}): string {
	return externalActionArmingId(input);
}

export function getExternalActionTransitionTrigger(input: { externalActionId: string }): string {
	return externalActionTransitionTrigger(input);
}

function previewMatchesTransition(
	preview: ProcessActionPreviewDefinition,
	transition: NormalizedActionRoute,
): boolean {
	if (preview.kind === "trigger") {
		return transition.trigger === preview.trigger;
	}
	if (preview.kind === "terminal") {
		return transition.lifecycleStatus === preview.lifecycleStatus;
	}
	return transition.nextTurnId === preview.turnId;
}

function validateActionPreviewMatchesTransitions(input: {
	turnId: TurnId;
	actionId: string;
	preview: ProcessActionPreviewDefinition;
	transitions: readonly NormalizedActionRoute[];
	context: "preview" | "scheduling";
}): void {
	const matches = input.transitions.filter((transition) =>
		previewMatchesTransition(input.preview, transition),
	);
	if (matches.length === 1) {
		return;
	}
	const previewLabel =
		input.preview.kind === "trigger"
			? `trigger '${input.preview.trigger}'`
			: input.preview.kind === "terminal"
				? `terminal '${input.preview.lifecycleStatus}'`
				: `fixed turn '${String(input.preview.turnId)}'`;
	throw new Error(
		`Action '${input.actionId}' on turn '${input.turnId}' ${input.context} does not match a compiled transition for ${previewLabel}`,
	);
}

function buildActionPreviewAndScheduling(
	turnId: TurnId,
	actionId: string,
	spec: Pick<BaseActionSpec<unknown, unknown>, "preview" | "schedulable">,
	transitions: readonly NormalizedActionRoute[],
): {
	preview?: ProcessActionPreviewDefinition;
	scheduling?: ProcessActionSchedulingDefinition;
} {
	const preview = (() => {
		if (spec.preview) {
			return spec.preview;
		}
		if (transitions.length !== 1) {
			return undefined;
		}
		const [transition] = transitions;
		if (!transition) {
			return undefined;
		}
		if (transition.lifecycleStatus !== undefined) {
			return {
				kind: "terminal",
				lifecycleStatus: transition.lifecycleStatus,
			} satisfies ProcessActionPreviewDefinition;
		}
		return {
			kind: "trigger",
			trigger: transition.trigger,
		} satisfies ProcessActionPreviewDefinition;
	})();
	if (spec.preview && preview) {
		validateActionPreviewMatchesTransitions({
			turnId,
			actionId,
			preview,
			transitions,
			context: "preview",
		});
	}
	if (spec.schedulable && preview) {
		validateActionPreviewMatchesTransitions({
			turnId,
			actionId,
			preview,
			transitions,
			context: "scheduling",
		});
	}
	if (spec.schedulable && !preview) {
		throw new Error(
			`Action '${actionId}' is schedulable but does not resolve to a unique preview transition`,
		);
	}
	return {
		...(preview ? { preview } : {}),
		...(spec.schedulable && preview ? { scheduling: { preview } } : {}),
	};
}

function mergeProcessEffectPlans<TState>(
	left: ProcessEffectPlan<TState> | undefined,
	right: ProcessEffectPlan<TState> | undefined,
): ProcessEffectPlan<TState> | undefined {
	if (!left) {
		return right;
	}
	if (!right) {
		return left;
	}
	return {
		...left,
		...right,
		...(left.processPatch || right.processPatch
			? { processPatch: { ...(left.processPatch ?? {}), ...(right.processPatch ?? {}) } }
			: {}),
		...(left.broadcasts || right.broadcasts
			? { broadcasts: [...(left.broadcasts ?? []), ...(right.broadcasts ?? [])] }
			: {}),
		...(left.emit || right.emit ? { emit: [...(left.emit ?? []), ...(right.emit ?? [])] } : {}),
		...(left.queueInput || right.queueInput
			? { queueInput: [...(left.queueInput ?? []), ...(right.queueInput ?? [])] }
			: {}),
	};
}

function normalizeEffectString(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function normalizeEffectStringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value
				.map((entry) => (typeof entry === "string" ? entry.trim() : ""))
				.filter((entry) => entry !== "")
		: [];
}

function getTurnReviewSubject(turnDef: TurnDefinition<unknown, unknown> | undefined) {
	if (!turnDef || !("reviewSubject" in turnDef)) {
		return null;
	}
	return turnDef.reviewSubject ?? null;
}

function patchReviewSubjectIntoState<TState>(
	state: TState,
	reviewSubject: ReviewSubject | null,
): TState {
	if (typeof state !== "object" || state === null || Array.isArray(state)) {
		return state;
	}
	return {
		...(state as Record<string, unknown>),
		reviewSubject,
	} as TState;
}

async function buildSavePlanResultEffect<TParams, TState>(input: {
	intent: SavePlanResultLifecycleIntent<TParams, TState>;
	execution: ProcessOutcomeExecution<TParams, TState>;
	targetTurn: TurnDefinition<unknown, unknown> | undefined;
}): Promise<ProcessEffectPlan<TState>> {
	const statePlan = input.intent.state ? await input.intent.state(input.execution) : undefined;
	const targetReviewSubject = getTurnReviewSubject(input.targetTurn);
	const baseState = statePlan?.state ?? input.execution.ctx.state;
	const planRevision = input.execution.ctx.process.planRevision + 1;
	const summary = normalizeEffectString(input.execution.event.params[input.intent.summaryParam]);
	const acceptanceCriteria = normalizeEffectStringArray(
		input.execution.event.params[input.intent.acceptanceCriteriaParam],
	);
	const planMarkdown =
		typeof input.execution.event.turnResultMarkdown === "string"
			? input.execution.event.turnResultMarkdown
			: normalizeEffectString(input.execution.event.params[input.intent.planMarkdownParam]);

	return mergeProcessEffectPlans(statePlan, {
		state: patchReviewSubjectIntoState(baseState, targetReviewSubject),
		processPatch: { planRevision },
		broadcasts: [
			{
				type: input.intent.broadcastType,
				payload: {
					planRevision,
					reviewState: "awaiting_approval",
					approved: false,
					summary,
				},
			},
		],
		emit: [
			{
				type: input.intent.emitEventType,
				data: {
					planRevision,
					summary,
					planMarkdown,
					acceptanceCriteria,
				},
			},
		],
	}) as ProcessEffectPlan<TState>;
}

function resolveOutcomeEffect<TParams, TState>(input: {
	spec: ProcessToolOutcomeSpec<TParams, TState> | ProcessTurnEndSpec<TParams, TState, string>;
	targetTurn: TurnDefinition<unknown, unknown> | undefined;
}): ProcessOutcomeEffect<TParams, TState> | undefined {
	const lifecycleIntent = "lifecycleIntent" in input.spec ? input.spec.lifecycleIntent : undefined;
	if (!lifecycleIntent) {
		return input.spec.effect;
	}
	return async (execution) => {
		const explicitPlan = input.spec.effect ? await input.spec.effect(execution) : undefined;
		let lifecyclePlan: ProcessEffectPlan<TState> | undefined;
		switch (lifecycleIntent.kind) {
			case "save_plan_result":
				lifecyclePlan = await buildSavePlanResultEffect({
					intent: lifecycleIntent,
					execution,
					targetTurn: input.targetTurn,
				});
				break;
		}
		return mergeProcessEffectPlans(explicitPlan, lifecyclePlan);
	};
}

function areFormsEquivalent(
	left: FormDefinition | undefined,
	right: FormDefinition | undefined,
): boolean {
	if (left === right) {
		return true;
	}
	return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function cloneStateForFormPatch<TState>(state: TState): TState {
	if (typeof state !== "object" || state === null) {
		throw new Error("Declarative form state fields require object process state");
	}
	return structuredClone(state);
}

function normalizeFormStateValue(field: FormDefinition["fields"][number], value: unknown): unknown {
	if (field.kind === "number") {
		const parsed = typeof value === "number" ? value : Number(String(value).trim());
		if (!Number.isFinite(parsed)) {
			throw new Error(`Field '${field.id}' must be a number`);
		}
		return parsed;
	}
	return value;
}

function applyFormStateFields<TState>(input: {
	form?: FormDefinition;
	inputValue: Record<string, unknown>;
	state: TState;
}): TState | undefined {
	const stateFields = (input.form?.fields ?? []).filter((field) => field.state);
	if (stateFields.length === 0) {
		return undefined;
	}
	const nextState = cloneStateForFormPatch(input.state) as Record<string, unknown>;
	for (const field of stateFields) {
		const rawValue = input.inputValue[field.id];
		if (rawValue === undefined) {
			continue;
		}
		const path = field.state?.path.trim();
		if (!path) {
			throw new Error(`Form field '${field.id}' declares an empty state path`);
		}
		const segments = path.split(".").map((segment) => segment.trim());
		if (segments.some((segment) => segment === "")) {
			throw new Error(`Form field '${field.id}' declares invalid state path '${path}'`);
		}
		let target: Record<string, unknown> = nextState;
		for (const segment of segments.slice(0, -1)) {
			const existing = target[segment];
			if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
				target[segment] = {};
			}
			target = target[segment] as Record<string, unknown>;
		}
		target[segments[segments.length - 1] as string] = normalizeFormStateValue(field, rawValue);
	}
	return nextState as TState;
}

function makeProcessServerRuntimeContext<TParams, TState>(
	ctx: ServerProcessContext<TParams, TState>,
): ProcessServerRuntimeContext<TParams, TState> {
	return {
		process: ctx.process,
		projects: ctx.projects,
		params: ctx.params,
		state: ctx.state,
		readSemanticTurnResultMarkdown: (ref) => ctx.readSemanticTurnResultMarkdown(ref),
		readProductTurnResultMarkdown: (productName) => ctx.readProductTurnResultMarkdown(productName),
	};
}

function mergeTransitionWithState<TState>(input: {
	result: ProcessEffectPlan<TState> | undefined;
	transition?: Omit<ServerTransitionRequest<TState>, "state">;
}): ServerTransitionRequest<TState> | null {
	const next = {
		...(input.transition ?? {}),
		...(input.result?.state !== undefined ? { state: input.result.state } : {}),
	};
	const hasFields =
		next.turnId !== undefined ||
		next.lifecycleStatus !== undefined ||
		next.trigger !== undefined ||
		next.effect !== undefined ||
		next.state !== undefined;
	return hasFields ? next : null;
}

function hasLifecycleEffects(result: ProcessEffectPlan | undefined): result is ProcessEffectPlan {
	return Boolean(
		result?.processPatch !== undefined ||
			(result?.broadcasts !== undefined && result.broadcasts.length > 0),
	);
}

async function applyProcessEffectPlan<TParams, TState>(input: {
	ctx: ServerProcessContext<TParams, TState>;
	result: ProcessEffectPlan<TState> | undefined;
	transition?: Omit<ServerTransitionRequest<TState>, "state">;
}): Promise<void> {
	const transition = mergeTransitionWithState({
		result: input.result,
		transition: input.transition,
	});
	if (transition) {
		await input.ctx.transition(transition);
	}
	if (hasLifecycleEffects(input.result)) {
		if (!input.ctx.applyLifecycleEffects) {
			throw new Error("Process lifecycle effects are not supported by this server context");
		}
		input.ctx.applyLifecycleEffects({
			...(input.result.processPatch ? { processPatch: input.result.processPatch } : {}),
			...(input.result.broadcasts ? { broadcasts: input.result.broadcasts } : {}),
		});
	}
	for (const emitted of input.result?.emit ?? []) {
		input.ctx.emitEvent(emitted.type, emitted.data as never);
	}
	for (const queuedInput of input.result?.queueInput ?? []) {
		input.ctx.queueInput(queuedInput);
	}
}

function compileTurnOutcomeDefinitions<TParams, TState>(input: {
	turnId: TurnId;
	outcomes?: Partial<Record<string, ProcessToolOutcomeSpec<TParams, TState>>>;
	turnEnd?: ProcessTurnEndSpec<TParams, TState, string>;
	knownTurnIds: ReadonlySet<TurnId>;
	turnDefinitionsById: ReadonlyMap<TurnId, TurnDefinition<unknown, unknown>>;
}): {
	transitions: readonly ProcessTurnTransition[];
	effects: ReadonlyMap<string, ProcessOutcomeEffect<TParams, TState> | undefined>;
} {
	const outcomeEntries = Object.entries(input.outcomes ?? {}) as Array<
		[string, ProcessToolOutcomeSpec<TParams, TState>]
	>;
	if (outcomeEntries.length > 0 && input.turnEnd) {
		throw new Error(
			`Turn '${input.turnId}' cannot declare both tool outcomes and a turnEnd result`,
		);
	}
	if (outcomeEntries.length === 0 && !input.turnEnd) {
		throw new Error(
			`Turn '${input.turnId}' must declare at least one tool outcome or a turnEnd result`,
		);
	}

	const transitions: ProcessTurnTransition[] = [];
	const effects = new Map<string, ProcessOutcomeEffect<TParams, TState> | undefined>();
	for (const [outcome, spec] of outcomeEntries) {
		if (outcome.trim() === "") {
			throw new Error(`Turn '${input.turnId}' declares an empty outcome id`);
		}
		const target = buildOutcomeTransition(input.turnId, outcome, spec, input.knownTurnIds);
		transitions.push({
			...(target.nextTurnId ? { nextTurnId: target.nextTurnId } : {}),
			...(target.lifecycleStatus ? { lifecycleStatus: target.lifecycleStatus } : {}),
			outcome,
		});
		effects.set(
			outcome,
			resolveOutcomeEffect({
				spec,
				targetTurn: target.nextTurnId
					? input.turnDefinitionsById.get(target.nextTurnId)
					: undefined,
			}),
		);
	}

	if (input.turnEnd) {
		if (input.turnEnd.outcome.trim() === "") {
			throw new Error(`Turn '${input.turnId}' declares an empty turnEnd outcome id`);
		}
		const target = buildOutcomeTransition(
			input.turnId,
			input.turnEnd.outcome,
			input.turnEnd,
			input.knownTurnIds,
		);
		transitions.push({
			...(target.nextTurnId ? { nextTurnId: target.nextTurnId } : {}),
			...(target.lifecycleStatus ? { lifecycleStatus: target.lifecycleStatus } : {}),
			outcome: input.turnEnd.outcome,
		});
		effects.set(
			input.turnEnd.outcome,
			resolveOutcomeEffect({
				spec: input.turnEnd,
				targetTurn: target.nextTurnId
					? input.turnDefinitionsById.get(target.nextTurnId)
					: undefined,
			}),
		);
	}

	return {
		transitions,
		effects,
	};
}

function addActionUse<TParams, TState>(input: {
	actionUses: Map<string, CompiledActionUse<TParams, TState>[]>;
	actionId: string;
	use: CompiledActionUse<TParams, TState>;
}) {
	const existing = input.actionUses.get(input.actionId) ?? [];
	if (existing.some((candidate) => candidate.turnId === input.use.turnId)) {
		throw new Error(
			`Turn '${input.use.turnId}' declares action '${input.actionId}' more than once`,
		);
	}
	existing.push(input.use);
	input.actionUses.set(input.actionId, existing);
}

type DerivedHumanTurnAction<TParams, TState> = {
	actionId: string;
	actionSpec: ProcessHumanTurnActionSpec<TParams, TState>;
	routing: CompiledActionRouting<TParams, TState>;
	transitions: readonly NormalizedActionRoute[];
	actionView: HumanTurnActionView;
	externalTriggers: readonly HumanTurnExternalTrigger[];
};

type DerivedHumanTurnExternalAction<TParams, TState> = {
	externalActionId: string;
	actionSpec: ProcessHumanTurnExternalActionSpec<TParams, TState>;
	transition: NormalizedActionRoute;
	view: HumanTurnExternalActionView;
};

function hasDeclaredStaticRouteTarget(target: StaticRouteTarget): boolean {
	return (
		target.to !== undefined || target.complete === true || target.lifecycleStatus !== undefined
	);
}

function resolveExternalActionRoute<TParams, TState>(input: {
	turnId: TurnId;
	externalActionId: string;
	spec: ProcessHumanTurnExternalActionSpec<TParams, TState>;
	knownTurnIds?: ReadonlySet<TurnId>;
}): NormalizedActionRoute {
	if (input.externalActionId.trim() === "") {
		throw new Error(`Human turn '${input.turnId}' declares an empty external action id`);
	}
	if (input.spec.id !== input.externalActionId) {
		throw new Error(
			`Human turn '${input.turnId}' external action '${input.externalActionId}' has mismatched spec id '${input.spec.id}'`,
		);
	}
	if (input.spec.source.kind.trim() === "") {
		throw new Error(
			`Human turn '${input.turnId}' external action '${input.externalActionId}' must declare a non-empty source kind`,
		);
	}
	const target = normalizeStaticRouteTarget(
		`Human turn '${input.turnId}' external action '${input.externalActionId}'`,
		input.spec,
		input.knownTurnIds,
	);
	return {
		...(target.nextTurnId ? { nextTurnId: target.nextTurnId } : {}),
		...(target.lifecycleStatus ? { lifecycleStatus: target.lifecycleStatus } : {}),
		trigger: externalActionTransitionTrigger({ externalActionId: input.externalActionId }),
	};
}

function validateExternalActionPublishedInputTarget<TParams, TState>(input: {
	turnId: TurnId;
	externalActionId: string;
	spec: ProcessHumanTurnExternalActionSpec<TParams, TState>;
	turnDefinitionsById?: ReadonlyMap<TurnId, TurnDefinition<unknown, unknown>>;
}): void {
	const publication = input.spec.publishInput;
	if (!publication || !input.turnDefinitionsById) {
		return;
	}
	if (input.spec.to === undefined) {
		throw new Error(
			`Human turn '${input.turnId}' external action '${input.externalActionId}' publishes input '${publication.productName}' but does not route to a consuming turn`,
		);
	}
	const targetTurn = input.turnDefinitionsById.get(input.spec.to);
	if (!targetTurn || targetTurn.kind !== "llm") {
		throw new Error(
			`Human turn '${input.turnId}' external action '${input.externalActionId}' publishes input '${publication.productName}' but target turn '${input.spec.to}' is not an LLM turn`,
		);
	}
	const consumed = new Set([
		...(targetTurn.consumedProducts ?? []),
		...(targetTurn.optionalConsumedProducts ?? []),
	]);
	if (!consumed.has(publication.productName)) {
		throw new Error(
			`Human turn '${input.turnId}' external action '${input.externalActionId}' publishes input '${publication.productName}' but target turn '${input.spec.to}' does not consume it`,
		);
	}
}

function validateActionPrimaryPrompt(
	turnId: TurnId,
	actionId: string,
	action: { form?: FormDefinition },
): void {
	const fields = action.form?.fields ?? [];
	const textualFields = fields.filter(
		(field) => field.kind === "text" || field.kind === "textarea",
	);
	const primaryPrompts = fields.filter((field) => field.primaryPrompt);
	if (primaryPrompts.some((field) => field.kind !== "text" && field.kind !== "textarea")) {
		throw new Error(
			`Human turn '${turnId}' action '${actionId}' primary prompt must be a text or textarea field`,
		);
	}
	if (primaryPrompts.length > 1) {
		throw new Error(
			`Human turn '${turnId}' action '${actionId}' must declare at most one primary prompt`,
		);
	}
	if (textualFields.length > 0 && primaryPrompts.length === 0) {
		throw new Error(
			`Human turn '${turnId}' action '${actionId}' with textual fields must declare a primary prompt`,
		);
	}
}

function deriveHumanTurnActions<TParams, TState>(input: {
	turnId: TurnId;
	spec: HumanTurnDefinition<TParams, TState>;
	knownTurnIds?: ReadonlySet<TurnId>;
	turnDefinitionsById?: ReadonlyMap<TurnId, TurnDefinition<unknown, unknown>>;
	requireHumanActions?: boolean;
}): {
	actions: readonly DerivedHumanTurnAction<TParams, TState>[];
	externalActions: readonly DerivedHumanTurnExternalAction<TParams, TState>[];
	transitions: readonly ProcessTurnTransition[];
} {
	const actionEntries = Object.entries(input.spec.actions) as Array<
		[string, ProcessHumanTurnActionSpec<TParams, TState>]
	>;
	if (actionEntries.length === 0 && input.knownTurnIds && input.requireHumanActions !== false) {
		throw new Error(`Human turn '${input.turnId}' must declare at least one action`);
	}

	const derivedActions: DerivedHumanTurnAction<TParams, TState>[] = [];
	const transitions: ProcessTurnTransition[] = [];
	const actionIdByTrigger = new Map<string, string>();
	for (const [actionId, actionSpec] of actionEntries) {
		if (actionId.trim() === "") {
			throw new Error(`Human turn '${input.turnId}' declares an empty action id`);
		}
		validateActionPrimaryPrompt(input.turnId, actionId, actionSpec);
		const resolved =
			!input.knownTurnIds &&
			!("branches" in actionSpec) &&
			!hasDeclaredStaticRouteTarget(actionSpec)
				? {
						routing: {
							kind: "static",
							route: { trigger: actionSpec.trigger ?? actionId },
						} satisfies CompiledActionRouting<TParams, TState>,
						transitions: [] as readonly NormalizedActionRoute[],
					}
				: resolveActionRouting({
						turnId: input.turnId,
						actionId,
						spec: actionSpec,
						knownTurnIds: input.knownTurnIds,
					});
		for (const transition of resolved.transitions) {
			const existingActionId = actionIdByTrigger.get(transition.trigger);
			if (existingActionId && existingActionId !== actionId) {
				throw new Error(
					`Human turn '${input.turnId}' contains duplicate action trigger '${transition.trigger}' across actions '${existingActionId}' and '${actionId}'`,
				);
			}
			actionIdByTrigger.set(transition.trigger, actionId);
			transitions.push({
				...(transition.nextTurnId ? { nextTurnId: transition.nextTurnId } : {}),
				...(transition.lifecycleStatus ? { lifecycleStatus: transition.lifecycleStatus } : {}),
				trigger: transition.trigger,
			});
		}
		const previewAndScheduling =
			!input.knownTurnIds && resolved.transitions.length === 0
				? {
						...(actionSpec.preview ? { preview: actionSpec.preview } : {}),
						...(actionSpec.schedulable && actionSpec.preview
							? { scheduling: { preview: actionSpec.preview } }
							: {}),
					}
				: buildActionPreviewAndScheduling(input.turnId, actionId, actionSpec, resolved.transitions);
		derivedActions.push({
			actionId,
			actionSpec,
			routing: resolved.routing,
			transitions: resolved.transitions,
			actionView: {
				actionId,
				label: actionSpec.label,
				description: actionSpec.description,
				acceptanceState: actionSpec.acceptanceState,
				...previewAndScheduling,
			},
			externalTriggers:
				actionSpec.externalTriggers?.map((trigger) => ({
					id: trigger.id,
					actionId,
					label: trigger.label,
					description: trigger.description,
				})) ?? [],
		});
	}

	const externalActionEntries = Object.entries(input.spec.externalActions ?? {}) as Array<
		[string, ProcessHumanTurnExternalActionSpec<TParams, TState>]
	>;
	const derivedExternalActions: DerivedHumanTurnExternalAction<TParams, TState>[] = [];
	const externalActionIds = new Set<string>();
	for (const [externalActionId, actionSpec] of externalActionEntries) {
		if (externalActionIds.has(externalActionId)) {
			throw new Error(
				`Human turn '${input.turnId}' declares duplicate external action '${externalActionId}'`,
			);
		}
		externalActionIds.add(externalActionId);
		if (actionSpec.publishInput) {
			assertValidProcessProductName(actionSpec.publishInput.productName);
			if (actionSpec.publishInput.inputField.trim() === "") {
				throw new Error(
					`Human turn '${input.turnId}' external action '${externalActionId}' publishInput must declare a non-empty inputField`,
				);
			}
		}
		validateExternalActionPublishedInputTarget({
			turnId: input.turnId,
			externalActionId,
			spec: actionSpec,
			turnDefinitionsById: input.turnDefinitionsById,
		});
		const transition = resolveExternalActionRoute({
			turnId: input.turnId,
			externalActionId,
			spec: actionSpec,
			knownTurnIds: input.knownTurnIds,
		});
		const existingActionId = actionIdByTrigger.get(transition.trigger);
		if (existingActionId) {
			throw new Error(
				`Human turn '${input.turnId}' contains duplicate trigger '${transition.trigger}' across action '${existingActionId}' and external action '${externalActionId}'`,
			);
		}
		actionIdByTrigger.set(transition.trigger, externalActionId);
		transitions.push({
			...(transition.nextTurnId ? { nextTurnId: transition.nextTurnId } : {}),
			...(transition.lifecycleStatus ? { lifecycleStatus: transition.lifecycleStatus } : {}),
			trigger: transition.trigger,
		});
		derivedExternalActions.push({
			externalActionId,
			actionSpec,
			transition,
			view: {
				id: externalActionArmingId({ turnId: input.turnId, externalActionId }),
				externalActionId,
				sourceKind: actionSpec.source.kind,
				label: actionSpec.label ?? actionSpec.source.label ?? null,
				description: actionSpec.description ?? actionSpec.source.description ?? null,
			},
		});
	}

	return {
		actions: derivedActions,
		externalActions: derivedExternalActions,
		transitions,
	};
}

export function resolveHumanTurnView<TParams, TState>(input: {
	turnId: TurnId;
	turn: HumanTurnDefinition<TParams, TState>;
}): {
	actions: readonly HumanTurnActionView[];
	externalTriggers: readonly HumanTurnExternalTrigger[];
	externalActions: readonly HumanTurnExternalActionView[];
} {
	const derived = deriveHumanTurnActions({
		turnId: input.turnId,
		spec: input.turn,
	});
	return {
		actions: derived.actions.map((action) => action.actionView),
		externalTriggers: derived.actions.flatMap((action) => action.externalTriggers),
		externalActions: derived.externalActions.map((action) => action.view),
	};
}

function compileHumanTurn<TParams, TState>(input: {
	turnId: TurnId;
	spec: HumanTurnDefinition<TParams, TState>;
	knownTurnIds: ReadonlySet<TurnId>;
	turnDefinitionsById: ReadonlyMap<TurnId, TurnDefinition<unknown, unknown>>;
	actionUses: Map<string, CompiledActionUse<TParams, TState>[]>;
}): {
	binding: ProcessTurnBinding<HumanTurnDefinition<TParams, TState>>;
} {
	const derived = deriveHumanTurnActions({
		turnId: input.turnId,
		spec: input.spec,
		knownTurnIds: input.knownTurnIds,
		turnDefinitionsById: input.turnDefinitionsById,
	});
	for (const action of derived.actions) {
		addActionUse({
			actionUses: input.actionUses,
			actionId: action.actionId,
			use: {
				turnId: input.turnId,
				label: action.actionSpec.label,
				...(action.actionSpec.form ? { form: action.actionSpec.form } : {}),
				...(action.actionSpec.effect ? { effect: action.actionSpec.effect } : {}),
				routing: action.routing,
			},
		});
	}

	return {
		binding: createProcessTurnBinding(input.spec, derived.transitions),
	};
}

function compileExternalTurn<TParams, TState>(input: {
	turnId: TurnId;
	spec: ExternalTurnDefinition<TParams, TState>;
	knownTurnIds: ReadonlySet<TurnId>;
}): {
	binding: ProcessTurnBinding<ExternalTurnDefinition<TParams, TState>>;
} {
	const transitions = compileExternalSourceTransitions({
		turnId: input.turnId,
		spec: input.spec,
		knownTurnIds: input.knownTurnIds,
	});
	return {
		binding: createProcessTurnBinding(input.spec, transitions),
	};
}

function getTurnEntries<TParams, TState>(
	turns: TurnDefinitionRecord<TParams, TState>,
): Array<[TurnId, TurnDefinition<TParams, TState>]> {
	return Object.entries(turns) as Array<[TurnId, TurnDefinition<TParams, TState>]>;
}

function resolveActionRouteForExecution<TParams, TState>(input: {
	use: CompiledActionUse<TParams, TState>;
	actionId: string;
	ctx: ServerProcessContext<TParams, TState>;
	inputValue: Record<string, unknown>;
}): MaybePromise<{
	route: NormalizedActionRoute;
	selectedBranchId?: string;
}> {
	if (input.use.routing.kind === "static") {
		return { route: input.use.routing.route };
	}
	const actionExecution: Omit<ProcessActionExecution<TParams, TState>, "selectedBranchId"> = {
		ctx: makeProcessServerRuntimeContext(input.ctx),
		input: input.inputValue,
		turnId: input.use.turnId,
		actionId: input.actionId,
	};
	const routes = input.use.routing.routes;
	return Promise.resolve(input.use.routing.choose(actionExecution)).then((selectedBranchId) => {
		if (!Object.hasOwn(routes, selectedBranchId)) {
			throw new Error(
				`Action '${input.actionId}' on turn '${input.use.turnId}' selected unknown branch '${selectedBranchId}'`,
			);
		}
		const route = routes[selectedBranchId];
		if (!route) {
			throw new Error(
				`Action '${input.actionId}' on turn '${input.use.turnId}' selected unknown branch '${selectedBranchId}'`,
			);
		}
		return { route, selectedBranchId };
	});
}

function buildActionTransitionRequest<TState>(route: NormalizedActionRoute) {
	if (route.nextTurnId !== undefined) {
		return {
			turnId: route.nextTurnId,
			trigger: route.trigger,
		} satisfies Omit<ServerTransitionRequest<TState>, "state">;
	}
	return {
		turnId: null,
		lifecycleStatus: route.lifecycleStatus,
		trigger: route.trigger,
	} satisfies Omit<ServerTransitionRequest<TState>, "state">;
}

function validateHappyPathConnectivity<TParams, TState>(input: {
	processId: string;
	happyPath: readonly TurnId[] | undefined;
	turns: ReadonlyMap<TurnId, ProcessTurnBinding<TurnDefinition<TParams, TState>>>;
	turnDefinitionsById: ReadonlyMap<TurnId, TurnDefinition<unknown, unknown>>;
}): void {
	const happyPath = input.happyPath;
	if (!happyPath || happyPath.length < 2) {
		return;
	}
	const happyPathTurns = new Set<TurnId>(happyPath);
	for (let index = 0; index < happyPath.length - 1; index += 1) {
		const source = happyPath[index];
		const target = happyPath[index + 1];
		let connected = false;
		const visited = new Set<TurnId>([source]);
		const queue: TurnId[] = [source];
		while (queue.length > 0 && !connected) {
			const current = queue.shift() as TurnId;
			for (const transition of getProcessTurnTransitions(input.turns.get(current))) {
				const next = transition.nextTurnId;
				if (next === undefined || !input.turnDefinitionsById.has(next)) {
					continue;
				}
				if (next === target) {
					connected = true;
					break;
				}
				if (visited.has(next) || happyPathTurns.has(next)) {
					continue;
				}
				const definition = input.turnDefinitionsById.get(next);
				if (definition?.kind !== "human") {
					continue;
				}
				visited.add(next);
				queue.push(next);
			}
		}
		if (!connected) {
			throw new Error(
				`Process '${input.processId}' happy path segment '${source}' -> '${target}' is not connected by declared transitions`,
			);
		}
	}
}

function buildDefinedProcess<TParams, TState>(
	input: DefinedProcessInput<TParams, TState>,
): Pick<ExtensionProcessDefinition<TParams, TState>, "turns" | "worker" | "server"> {
	const turnEntries = getTurnEntries(input.turns);
	if (turnEntries.length === 0) {
		throw new Error(`Process '${input.id}' must declare at least one turn`);
	}
	const knownTurnIds = new Set(turnEntries.map(([turnId]) => turnId));
	const turnDefinitionsById = new Map<TurnId, TurnDefinition<unknown, unknown>>(
		turnEntries.map(([turnId, turnSpec]) => [turnId, turnSpec as TurnDefinition<unknown, unknown>]),
	);
	if (!knownTurnIds.has(input.entry)) {
		throw new Error(`Process '${input.id}' entry turn '${input.entry}' is not declared`);
	}
	const seenEntries = new Set<TurnId>();
	for (const turnId of [input.entry, ...(input.alternateEntries ?? [])]) {
		if (seenEntries.has(turnId)) {
			throw new Error(`Process '${input.id}' declares duplicate entry turn '${turnId}'`);
		}
		if (!knownTurnIds.has(turnId)) {
			throw new Error(`Process '${input.id}' entry turn '${turnId}' is not declared`);
		}
		seenEntries.add(turnId);
	}

	if (input.happyPath) {
		if (input.happyPath.length === 0) {
			throw new Error(`Process '${input.id}' declares an empty happy path`);
		}
		const seen = new Set<TurnId>();
		for (const turnId of input.happyPath) {
			if (!knownTurnIds.has(turnId)) {
				throw new Error(`Process '${input.id}' happy path references undeclared turn '${turnId}'`);
			}
			if (seen.has(turnId)) {
				throw new Error(`Process '${input.id}' happy path repeats turn '${turnId}'`);
			}
			seen.add(turnId);
		}
		if (input.happyPath[0] !== input.entry) {
			throw new Error(
				`Process '${input.id}' happy path must start at the entry turn '${input.entry}'`,
			);
		}
	}

	const turns = new Map<TurnId, ProcessTurnBinding<TurnDefinition<TParams, TState>>>();
	const actionUses = new Map<string, CompiledActionUse<TParams, TState>[]>();
	const outcomeEffects = new Map<
		TurnId,
		ReadonlyMap<string, ProcessOutcomeEffect<TParams, TState> | undefined>
	>();
	const executableTurns = new Map<TurnId, CompiledExecutableTurn<TParams, TState>>();

	for (const [turnId, turnSpec] of turnEntries) {
		if (turnSpec.kind === "llm") {
			const compiledOutcomes = compileTurnOutcomeDefinitions({
				turnId,
				outcomes: turnSpec.outcomes,
				turnEnd: turnSpec.turnEnd,
				knownTurnIds,
				turnDefinitionsById,
			});
			turns.set(turnId, createProcessTurnBinding(turnSpec, compiledOutcomes.transitions));
			outcomeEffects.set(turnId, compiledOutcomes.effects);
			executableTurns.set(turnId, {
				kind: "llm",
				id: turnId,
				spec: turnSpec,
			});
			continue;
		}

		if (turnSpec.kind === "automatic" || turnSpec.kind === "server_automatic") {
			const compiledOutcomes = compileTurnOutcomeDefinitions({
				turnId,
				outcomes: turnSpec.outcomes,
				turnEnd: turnSpec.turnEnd,
				knownTurnIds,
				turnDefinitionsById,
			});
			const externalTransitions =
				turnSpec.kind === "automatic" && turnSpec.externalActions
					? deriveHumanTurnActions({
							turnId,
							spec: { kind: "human", description: turnSpec.description, actions: {}, externalActions: turnSpec.externalActions },
							knownTurnIds,
							turnDefinitionsById,
							requireHumanActions: false,
						}).transitions
					: [];
			turns.set(
				turnId,
				createProcessTurnBinding(turnSpec, [...compiledOutcomes.transitions, ...externalTransitions]),
			);
			outcomeEffects.set(turnId, compiledOutcomes.effects);
			if (turnSpec.kind === "automatic") {
				executableTurns.set(turnId, {
					kind: "automatic",
					id: turnId,
					spec: turnSpec,
				});
			}
			continue;
		}

		if (turnSpec.kind === "human") {
			const compiled = compileHumanTurn({
				turnId,
				spec: turnSpec,
				knownTurnIds,
				turnDefinitionsById,
				actionUses,
			});
			turns.set(turnId, compiled.binding);
			continue;
		}

		const compiled = compileExternalTurn({
			turnId,
			spec: turnSpec,
			knownTurnIds,
		});
		turns.set(turnId, compiled.binding);
	}

	validateHappyPathConnectivity({
		processId: input.id,
		happyPath: input.happyPath,
		turns,
		turnDefinitionsById,
	});

	const worker: ExtensionProcessDefinition<TParams, TState>["worker"] = (api) => {
		api.start(input.entry);
		const manuallyRegisteredTurns = new Set<TurnId>();
		input.worker?.({
			start(turnId) {
				api.start(turnId);
			},
			turn(turnId, handler) {
				manuallyRegisteredTurns.add(turnId);
				api.turn(turnId, handler);
			},
		});
		for (const executable of executableTurns.values()) {
			if (manuallyRegisteredTurns.has(executable.id)) {
				continue;
			}
			if (executable.kind === "llm") {
				api.turn(executable.id, async (run) => {
					await run.turn(executable.spec);
				});
				continue;
			}
			api.turn(executable.id, async (run) => {
				await run.complete(await executable.spec.run(run.ctx));
			});
		}
	};

	const server: ExtensionProcessDefinition<TParams, TState>["server"] = (api) => {
		for (const [actionId, uses] of actionUses) {
			const [firstUse] = uses;
			const form = firstUse?.form;
			for (const use of uses) {
				if (!areFormsEquivalent(form, use.form)) {
					throw new Error(
						`Action '${actionId}' must use the same form on every turn that references it`,
					);
				}
			}
			api.action({
				id: actionId,
				label: firstUse?.label ?? actionId,
				...(form ? { form } : {}),
				async plan(inputValue, ctx) {
					const turnId = ctx.process.selectedTurnId;
					const use = uses.find((candidate) => candidate.turnId === turnId);
					if (!use || !turnId) {
						throw new Error(
							`Action '${actionId}' is not available for selected turn '${String(turnId)}'`,
						);
					}
					const resolvedRoute = await resolveActionRouteForExecution({
						use,
						actionId,
						ctx,
						inputValue,
					});
					const effectResult = use.effect
						? await use.effect({
								ctx: makeProcessServerRuntimeContext(ctx),
								input: inputValue,
								turnId,
								actionId,
								...(resolvedRoute.selectedBranchId
									? { selectedBranchId: resolvedRoute.selectedBranchId }
									: {}),
							})
						: undefined;
					const formState = applyFormStateFields({
						form: use.form,
						inputValue,
						state: effectResult?.state ?? ctx.state,
					});
					const result = formState
						? mergeProcessEffectPlans(effectResult, { state: formState })
						: effectResult;
					await applyProcessEffectPlan({
						ctx,
						result,
						transition: buildActionTransitionRequest(resolvedRoute.route),
					});
				},
			});
		}

		for (const [turnId, effects] of outcomeEffects) {
			api.onTurnOutcome(turnId, async (event, ctx) => {
				const effect = effects.get(event.outcome);
				if (!effect) {
					return;
				}
				const result = await effect({
					ctx: makeProcessServerRuntimeContext(ctx),
					event,
					turnId,
					outcome: event.outcome,
				});
				await applyProcessEffectPlan({ ctx, result });
			});
		}

		input.server?.(api);
	};

	return {
		turns,
		worker,
		server,
	};
}

export function defineProcess<TParams = unknown, TState = unknown>(
	input: DefinedProcessInput<TParams, TState>,
): ProcessDefinition<TParams, TState> {
	const compiled = buildDefinedProcess(input);
	const process = {
		id: input.id,
		displayName: input.displayName,
		entryTurnId: input.entry,
		alternateEntryTurnIds: [...(input.alternateEntries ?? [])],
		...(input.happyPath ? { happyPath: [...input.happyPath] } : {}),
		turns: compiled.turns,
		paramsCodec: input.paramsCodec,
		stateCodec: input.stateCodec,
		initialState: input.initialState,
		...(input.repositoryCredentials ? { repositoryCredentials: input.repositoryCredentials } : {}),
		...(input.piConfig ? { piConfig: input.piConfig } : {}),
		server: compiled.server,
		worker: compiled.worker,
		ui: input.ui,
		launchers: input.launchers,
		watchers: input.watchers,
	};
	markDefinedProcess(process);
	return process;
}

type RoutableTurnDefinition<TOutcome extends string, TParams, TState> =
	| LlmTurnDefinition<TOutcome, TParams, TState>
	| AutomaticTurnDefinition<TOutcome, TParams, TState>
	| ServerAutomaticTurnDefinition<TOutcome, TParams, TState>;

// biome-ignore-start lint/suspicious/noExplicitAny: conditional helper types must match and preserve any routable turn instantiation
type RoutableOutcome<TTurn> =
	TTurn extends RoutableTurnDefinition<infer TOutcome, any, any> ? TOutcome : never;
type RoutableParams<TTurn> =
	TTurn extends RoutableTurnDefinition<any, infer TParams, any> ? TParams : never;
type RoutableState<TTurn> =
	TTurn extends RoutableTurnDefinition<any, any, infer TState> ? TState : never;

export function routeTurnOutcomes<TTurn extends RoutableTurnDefinition<string, any, any>>(
	baseTurn: TTurn,
	routes: Partial<
		Record<RoutableOutcome<TTurn>, OutcomeRouteSpec<RoutableParams<TTurn>, RoutableState<TTurn>>>
	>,
	options: OutcomeRouteOptions = {},
): TTurn {
	type TOutcome = RoutableOutcome<TTurn>;
	type TParams = RoutableParams<TTurn>;
	type TState = RoutableState<TTurn>;
	const baseOutcomes = (baseTurn.outcomes ?? {}) as Partial<
		Record<TOutcome, ProcessToolOutcomeSpec<TParams, TState>>
	>;
	for (const outcomeId of Object.keys(routes) as TOutcome[]) {
		if (!baseOutcomes[outcomeId]) {
			throw new Error(`Cannot route unknown outcome '${outcomeId}' on reusable turn`);
		}
	}
	if (options.strict) {
		for (const outcomeId of Object.keys(baseOutcomes) as TOutcome[]) {
			if (!routes[outcomeId]) {
				throw new Error(`Strict routing omitted outcome '${outcomeId}' on reusable turn`);
			}
		}
	}
	return {
		...baseTurn,
		outcomes: Object.fromEntries(
			(
				Object.entries(baseOutcomes) as Array<[TOutcome, ProcessToolOutcomeSpec<TParams, TState>]>
			).map(([outcomeId, baseOutcome]) => [
				outcomeId,
				{ ...baseOutcome, ...(routes[outcomeId] ?? {}) },
			]),
		) as Partial<Record<TOutcome, ProcessToolOutcomeSpec<TParams, TState>>>,
	};
}
// biome-ignore-end lint/suspicious/noExplicitAny: end routable turn instantiation helper suppression

export function llmTurn<TParams = unknown, TState = unknown, TOutcome extends string = string>(
	input: Omit<LlmTurnDefinition<TOutcome, TParams, TState>, "kind">,
): LlmTurnDefinition<TOutcome, TParams, TState> {
	return {
		...input,
		kind: "llm",
	};
}

export function automaticTurn<
	TParams = unknown,
	TState = unknown,
	TOutcome extends string = string,
>(
	input: Omit<AutomaticTurnDefinition<TOutcome, TParams, TState>, "kind">,
): AutomaticTurnDefinition<TOutcome, TParams, TState> {
	return {
		...input,
		kind: "automatic",
	};
}

export function serverAutomaticTurn<
	TParams = unknown,
	TState = unknown,
	TOutcome extends string = string,
>(
	input: Omit<ServerAutomaticTurnDefinition<TOutcome, TParams, TState>, "kind">,
): ServerAutomaticTurnDefinition<TOutcome, TParams, TState> {
	return {
		...input,
		kind: "server_automatic",
	};
}

export function humanTurn<TParams = unknown, TState = unknown>(
	input: Omit<HumanTurnDefinition<TParams, TState>, "kind">,
): HumanTurnDefinition<TParams, TState> {
	return {
		...input,
		kind: "human",
	};
}

export function externalTurn<TParams = unknown, TState = unknown>(
	input: Omit<ExternalTurnDefinition<TParams, TState>, "kind">,
): ExternalTurnDefinition<TParams, TState> {
	return {
		...input,
		kind: "external",
	};
}
