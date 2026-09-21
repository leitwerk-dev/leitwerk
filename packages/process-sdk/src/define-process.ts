import {
	assertValidProcessProductName,
	trimString as normalizeEffectString,
	normalizeStringArray as normalizeEffectStringArray,
	type ProcessInstance,
	type ProcessSemanticEntryRefKey,
	type ProcessTurnStartSelection,
	type ProcessTurnTerminalLifecycleStatus,
	type ProcessTurnTransition,
	type TurnId,
	type TurnProgressReport,
} from "@leitwerk-dev/domain";
import type {
	ExtensionProcessDefinition,
	ExternalActionSource,
	ExternalSourceEffect,
	ExternalSourceResolveContext,
	FormDefinition,
	ProcessTurnBinding,
	ProcessTurnOutcomeEvent,
	ServerProcessContext,
	ServerTransitionRequest,
	WorkerCompleteInput,
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
	TurnAcceptanceState,
	TurnBranchType,
	TurnCompletionMode,
	TurnContextMode,
	TurnResultMarkdownBehavior,
} from "./types.js";

/** @internal */
type ProcessEventName = keyof ServerExtensionEventMap & string;

/** @internal */
type ProcessEmittedEvent = {
	/** @internal */
	type: ProcessEventName;
	/** @internal */
	data: unknown;
};

/** @public */
type ProcessQueuedInput = Parameters<ServerProcessContext["queueInput"]>[0];

/** @public */
type MaybePromise<T> = T | Promise<T>;

/** @public */
type StaticRouteTarget = {
	/** @public */
	to?: TurnId;
	/** @internal */
	complete?: boolean;
	/** @public */
	lifecycleStatus?: ProcessTurnTerminalLifecycleStatus;
};

type NormalizedRouteTarget = {
	nextTurnId?: TurnId;
	lifecycleStatus?: ProcessTurnTerminalLifecycleStatus;
};

type NormalizedActionRoute = NormalizedRouteTarget & {
	trigger: string;
};

/** @public */
export interface ProcessRuntimeTurnContext<TParams = unknown, TState = unknown>
	extends WorkerProcessContext<TParams, TState> {}

/** @internal */
export interface LlmTurnPreparationContext<TParams = unknown, TState = unknown>
	extends ProcessRuntimeTurnContext<TParams, TState> {
	/** @internal */
	callIntegrationTool(name: string, args: Record<string, unknown>): Promise<unknown>;
	/** @internal */
	reportProgress(report: TurnProgressReport): void;
}

/** @public */
export interface ProcessServerRuntimeContext<TParams = unknown, TState = unknown> {
	/** @internal */
	readonly process: ServerProcessContext<TParams, TState>["process"];
	/** @internal */
	readonly projects: ServerProcessContext<TParams, TState>["projects"];
	/** @internal */
	readonly params: TParams;
	/** @public */
	readonly state: TState;
	/** @internal */
	readSemanticTurnResultMarkdown(ref: ProcessSemanticEntryRefKey): string | null;
	/** @internal */
	readProductTurnResultMarkdown(productName: string): string | null;
	/** @internal */
	reportProgress?(report: TurnProgressReport): void;
}

/** @internal */
export interface ProcessBroadcastEffect {
	/** @internal */
	type: string;
	/** @internal */
	payload: Record<string, unknown>;
}

/** @public */
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

/** @public */
export interface ProcessLifecycleEffects {
	/** @public */
	processPatch?: ProcessPatchEffect;
	/** @internal */
	broadcasts?: readonly ProcessBroadcastEffect[];
}

/** @public */
export interface ProcessEffectPlan<TState = unknown> extends ProcessLifecycleEffects {
	/** @public */
	state?: TState;
	/** @internal */
	emit?: readonly ProcessEmittedEvent[];
	/** @public */
	queueInput?: readonly ProcessQueuedInput[];
}

/** @internal */
export interface SavePlanResultLifecycleIntent<TParams = unknown, TState = unknown> {
	/** @internal */
	kind: "save_plan_result";
	/** @internal */
	summaryParam: string;
	/** @internal */
	acceptanceCriteriaParam: string;
	/** @internal */
	planMarkdownParam: string;
	/** @internal */
	emitEventType: ProcessEventName;
	/** @internal */
	broadcastType: string;
	/** @internal */
	state?: ProcessOutcomeEffect<TParams, TState>;
}

/** @internal */
export type ProcessOutcomeLifecycleIntent<
	TParams = unknown,
	TState = unknown,
> = SavePlanResultLifecycleIntent<TParams, TState>;

/** @public */
export interface ProcessActionExecution<TParams = unknown, TState = unknown> {
	/** @public */
	readonly ctx: ProcessServerRuntimeContext<TParams, TState>;
	/** @public */
	readonly input: Record<string, unknown>;
	/** @internal */
	readonly turnId: TurnId;
	/** @internal */
	readonly actionId: string;
	/** @internal */
	readonly selectedBranchId?: string;
}

/** @public */
export interface ProcessOutcomeExecution<TParams = unknown, TState = unknown> {
	/** @internal */
	readonly ctx: ProcessServerRuntimeContext<TParams, TState>;
	/** @internal */
	readonly event: ProcessTurnOutcomeEvent;
	/** @internal */
	readonly turnId: TurnId;
	/** @internal */
	readonly outcome: string;
}

/** @public */
export type ProcessActionEffect<TParams = unknown, TState = unknown> = (
	input: ProcessActionExecution<TParams, TState>,
) => MaybePromise<ProcessEffectPlan<TState> | undefined>;

/** @public */
export type ProcessActionBranchSelector<TParams = unknown, TState = unknown> = (
	input: Omit<ProcessActionExecution<TParams, TState>, "selectedBranchId">,
) => MaybePromise<string>;

/** @public */
export type ProcessOutcomeEffect<TParams = unknown, TState = unknown> = (
	input: ProcessOutcomeExecution<TParams, TState>,
) => MaybePromise<ProcessEffectPlan<TState> | undefined>;

/** @internal */
export type ProcessOutcomeBranchSelector<TParams = unknown, TState = unknown> = (
	input: ProcessOutcomeExecution<TParams, TState>,
) => MaybePromise<string>;

/** @internal */
export interface ProcessOutcomeBranchSpec extends StaticRouteTarget {
	/** @internal */
	trigger?: string;
}

/** @internal */
export interface ProcessActionExternalTrigger {
	/** @internal */
	id: string;
	/** @internal */
	label: string;
	/** @internal */
	description: string;
}

/** @internal */
export interface ExternalActionInputPublication {
	/** @internal */
	productName: string;
	/** @internal */
	inputField: string;
}

/** @public */
export interface ProcessHumanTurnExternalActionSpec<
	TParams = unknown,
	TState = unknown,
	TEvent = unknown,
	TInput extends Record<string, unknown> = Record<string, unknown>,
> extends StaticRouteTarget {
	/** @internal */
	id: string;
	/** @internal */
	source: ExternalActionSource<TParams, TState, TEvent, TInput>;
	/** Arms and exposes this action only when the current process snapshot matches. @public */
	when?: (ctx: ExternalSourceResolveContext<TParams, TState>) => boolean;
	/** @internal */
	label?: string;
	/** @internal */
	description?: string;
	/** @internal */
	publishInput?: ExternalActionInputPublication;
	/** @public */
	effect?: ExternalSourceEffect<TParams, TState, TEvent, TInput>;
}

/** @public */
export interface ProcessActionBranchSpec extends StaticRouteTarget {
	/** @internal */
	trigger?: string;
}

/** @public */
type StaticActionRouting = StaticRouteTarget & {
	/** @internal */
	trigger?: string;
};

/** @public */
type BranchingActionRouting<TParams, TState> = {
	/** @public */
	branches: Record<string, ProcessActionBranchSpec>;
	/** @public */
	choose: ProcessActionBranchSelector<TParams, TState>;
};

/** @public */
interface BaseActionSpec<TParams, TState> {
	/** @public */
	label: string;
	/** @public */
	description?: string;
	/** @internal */
	form?: FormDefinition;
	/** @public */
	preview?: ProcessActionPreviewDefinition;
	/** @public */
	schedulable?: boolean;
	/** @public */
	effect?: ProcessActionEffect<TParams, TState>;
}

/** @public */
export type ProcessHumanTurnActionSpec<TParams = unknown, TState = unknown> = BaseActionSpec<
	TParams,
	TState
> & {
	/** @public */
	acceptanceState: TurnAcceptanceState;
	/** @internal */
	externalTriggers?: readonly ProcessActionExternalTrigger[];
} & (StaticActionRouting | BranchingActionRouting<TParams, TState>);

/** @public */
interface ProcessToolOutcomeBaseSpec<TParams = unknown, TState = unknown> {
	/** @internal */
	description: string;
	/** @internal */
	parameters: Record<string, OutcomeToolParameterSpec>;
	/** Product published from this outcome's turn-result markdown, when this outcome is selected. @internal */
	publishedProduct?: string;
	/** Outcome parameter whose markdown value is captured as the turn result. @internal */
	turnResultMarkdownParameter?: string;
	/** Outcome parameter containing a concise operator-facing summary. @internal */
	resultSummaryParameter?: string;
	/** @internal */
	effect?: ProcessOutcomeEffect<TParams, TState>;
	/** @internal */
	lifecycleIntent?: ProcessOutcomeLifecycleIntent<TParams, TState>;
}

/** @public */
export type ProcessToolOutcomeSpec<
	TParams = unknown,
	TState = unknown,
> = ProcessToolOutcomeBaseSpec<TParams, TState> &
	(
		| StaticRouteTarget
		| {
				/** @internal */
				branches: Record<string, ProcessOutcomeBranchSpec>;
				/** @internal */
				choose: ProcessOutcomeBranchSelector<TParams, TState>;
		  }
	);
/** @public */
export type HumanTurnOperatorAttention = "required" | "passive";

/** @public */
export interface HumanTurnDefinition<TParams = unknown, TState = unknown> {
	/** @public */
	kind: "human";
	/** @public */
	description: string;
	/** Named product rendered as the subject of this human review turn. @internal */
	reviewProduct?: string;
	/** @internal */
	reviewSemanticRef?: ProcessSemanticEntryRefKey;
	/** Controls whether entering this turn should raise an action-required toast. @public */
	operatorAttention?: HumanTurnOperatorAttention;
	/** @internal */
	notesFields?: readonly HumanTurnNotesField[];
	/** @internal */
	commentary?: string;
	/** @public */
	actions: Record<string, ProcessHumanTurnActionSpec<TParams, TState>>;
	/** @internal */
	externalActions?: Record<string, ProcessHumanTurnExternalActionSpec<TParams, TState>>;
}

/** @public */
export interface ProcessTurnEndSpec<
	TParams = unknown,
	TState = unknown,
	TOutcome extends string = string,
> extends StaticRouteTarget {
	/** @public */
	outcome: TOutcome;
	/** @public */
	params?: Record<string, unknown>;
	/** @public */
	effect?: ProcessOutcomeEffect<TParams, TState>;
}

/** @internal */
export type OutcomeRouteSpec<TParams = unknown, TState = unknown> = StaticRouteTarget &
	Partial<Pick<ProcessToolOutcomeSpec<TParams, TState>, "description" | "parameters" | "effect">>;

/** @internal */
export interface OutcomeRouteOptions {
	/** @internal */
	strict?: boolean;
}

/** @internal */
export type LlmModelPurpose = "process_title_generation";

/** @public */
export interface LlmTurnDefinition<
	TOutcome extends string = string,
	TParams = unknown,
	TState = unknown,
> {
	/** @public */
	kind: "llm";
	/** @public */
	description: string;
	/** Code-defined model policy purpose. Purpose selections cannot be overridden per launch/action. @internal */
	modelPurpose?: LlmModelPurpose;
	/** Built-in Pi tools active while this turn runs. @public */
	availableTools: readonly PiBuiltInToolName[];
	/** Server-owned integration tools proxied over authenticated worker IPC. @internal */
	integrationTools?: readonly string[];
	/** Resolve a constrained tool set from validated durable process data at turn start. @public */
	resolveIntegrationTools?: (params: TParams, state: TState) => readonly string[];
	/** Opt in to the durable, operator-facing ask_questions custom tool. @internal */
	askQuestions?: boolean;
	/** Deterministic worker preparation that must complete before Pi is prompted. @internal */
	prepare?(ctx: LlmTurnPreparationContext<TParams, TState>): MaybePromise<unknown>;
	/** @public */
	completionMode?: TurnCompletionMode;
	/** @public */
	branchType: TurnBranchType;
	/** @public */
	context: TurnContextMode;
	/** @internal */
	startFrom?: ProcessTurnStartSelection;
	/** @internal */
	restorePrimaryLeafAfterTurn?: boolean;
	/** @public */
	prompt(ctx: ProcessRuntimeTurnContext<TParams, TState>): string | Promise<string>;
	/** @public */
	outcomes?: Partial<Record<TOutcome, ProcessToolOutcomeSpec<TParams, TState>>>;
	/** @public */
	turnEnd?: ProcessTurnEndSpec<TParams, TState, TOutcome>;
	/** @public */
	turnResultMarkdown?: TurnResultMarkdownBehavior;
	/** @internal */
	reviewSemanticRef?: ProcessSemanticEntryRefKey;
	/** @internal */
	resultSemanticRef?: ProcessSemanticEntryRefKey;
	/** @internal */
	publishedProduct?: string;
	/** @internal */
	consumedProducts?: readonly string[];
	/** @internal */
	optionalConsumedProducts?: readonly string[];
	/** @internal */
	requiredSemanticMarkdownRefs?: readonly ProcessSemanticEntryRefKey[];
	/** @internal */
	optionalSemanticMarkdownRefs?: readonly ProcessSemanticEntryRefKey[];
}

/** @public */
export interface AutomaticTurnDefinition<
	TOutcome extends string = string,
	TParams = unknown,
	TState = unknown,
> {
	/** @public */
	kind: "automatic";
	/** @public */
	description: string;
	/** Server-owned integration tools callable by this deterministic worker turn. @internal */
	integrationTools?: readonly string[];
	/** External events armed while this automatic turn is selected and waiting. @public */
	externalActions?: Record<string, ProcessHumanTurnExternalActionSpec<TParams, TState>>;
	/** @internal */
	outcomes?: Partial<Record<TOutcome, ProcessToolOutcomeSpec<TParams, TState>>>;
	/** @internal */
	turnEnd?: ProcessTurnEndSpec<TParams, TState, TOutcome>;
	/** @internal */
	reviewSemanticRef?: ProcessSemanticEntryRefKey;
	/** @public */
	run(
		ctx: ProcessRuntimeTurnContext<TParams, TState>,
	): Promise<WorkerCompleteInput<TOutcome>> | WorkerCompleteInput<TOutcome>;
}

/** @internal */
export interface ExternalSourceTransition<
	TParams = unknown,
	TState = unknown,
	TEvent = unknown,
	TInput extends Record<string, unknown> = Record<string, unknown>,
> extends StaticRouteTarget {
	/** @internal */
	source: ExternalActionSource<TParams, TState, TEvent, TInput>;
	/** @internal */
	effect?: ExternalSourceEffect<TParams, TState, TEvent, TInput>;
}

/** @public */
export interface ExternalTurnDefinition<TParams = unknown, TState = unknown> {
	/** @public */
	kind: "external";
	/** @public */
	description: string;
	/** @internal */
	transitions: readonly ExternalSourceTransition<TParams, TState>[];
	/** @internal */
	reviewSemanticRef?: ProcessSemanticEntryRefKey;
}

/** @public */
export type TurnDefinition<TParams = unknown, TState = unknown> =
	| LlmTurnDefinition<string, TParams, TState>
	| AutomaticTurnDefinition<string, TParams, TState>
	| HumanTurnDefinition<TParams, TState>
	| ExternalTurnDefinition<TParams, TState>;

/** @public */
export type TurnDefinitionRecord<TParams = unknown, TState = unknown> = Record<
	TurnId,
	TurnDefinition<TParams, TState>
>;

/** @public */
export type ProcessDefinition<TParams = unknown, TState = unknown> = ExtensionProcessDefinition<
	TParams,
	TState
>;

/** @public */
export interface DefinedProcessInput<TParams = unknown, TState = unknown>
	extends Omit<
		ExtensionProcessDefinition<TParams, TState>,
		"entryTurnId" | "alternateEntryTurnIds" | "turns"
	> {
	/** Primary entry used when a launch does not select a start turn explicitly. @public */
	entry: TurnId;
	/** Additional entry turns that launchers may select explicitly. @public */
	alternateEntries?: readonly TurnId[];
	/** @public */
	turns: TurnDefinitionRecord<TParams, TState>;
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

interface CompiledOutcomeHandlers<TParams, TState> {
	effects: ReadonlyMap<string, ProcessOutcomeEffect<TParams, TState> | undefined>;
	routings: ReadonlyMap<string, CompiledOutcomeRouting<TParams, TState>>;
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
		throw new Error(
			`${context} must declare exactly one target via 'to', 'complete', or 'lifecycleStatus'`,
		);
	}
	if (target.to !== undefined) {
		if (knownTurnIds && !knownTurnIds.has(target.to)) {
			throw new Error(`${context} references unknown turn '${target.to}'`);
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
	if ("branches" in target) {
		throw new Error(
			`Turn '${turnId}' outcome '${outcome}' must compile state routing before a static transition`,
		);
	}
	if (!hasDeclaredStaticRouteTarget(target)) {
		return { nextTurnId: turnId };
	}
	return normalizeStaticRouteTarget(`Turn '${turnId}' outcome '${outcome}'`, target, knownTurnIds);
}

type CompiledOutcomeRouting<TParams, TState> = {
	routes: Readonly<Record<string, NormalizedActionRoute>>;
	choose: ProcessOutcomeBranchSelector<TParams, TState>;
};

type BranchRouteSpec = StaticRouteTarget & { trigger?: string };

function compileBranchRoutes(input: {
	branches: Record<string, BranchRouteSpec>;
	knownTurnIds?: ReadonlySet<TurnId>;
	targetContext(branchId: string): string;
	emptyBranchError: string;
	duplicateTriggerError(trigger: string): string;
}): {
	routes: Record<string, NormalizedActionRoute>;
	transitions: NormalizedActionRoute[];
} {
	const routes: Record<string, NormalizedActionRoute> = {};
	const transitions: NormalizedActionRoute[] = [];
	const usedTriggers = new Set<string>();
	for (const [branchId, branchSpec] of Object.entries(input.branches)) {
		if (branchId.trim() === "") throw new Error(input.emptyBranchError);
		const target = normalizeStaticRouteTarget(
			input.targetContext(branchId),
			branchSpec,
			input.knownTurnIds,
		);
		const trigger = branchSpec.trigger ?? branchId;
		if (usedTriggers.has(trigger)) throw new Error(input.duplicateTriggerError(trigger));
		usedTriggers.add(trigger);
		const route = { ...target, trigger };
		routes[branchId] = route;
		transitions.push(route);
	}
	return { routes, transitions };
}

function resolveOutcomeRouting<TParams, TState>(input: {
	turnId: TurnId;
	outcome: string;
	spec: ProcessToolOutcomeSpec<TParams, TState>;
	knownTurnIds: ReadonlySet<TurnId>;
}): CompiledOutcomeRouting<TParams, TState> | null {
	if (!("branches" in input.spec)) {
		return null;
	}
	const entries = Object.entries(input.spec.branches);
	if (entries.length === 0) {
		throw new Error(
			`Turn '${input.turnId}' outcome '${input.outcome}' must declare at least one branch`,
		);
	}
	const { routes } = compileBranchRoutes({
		branches: input.spec.branches,
		knownTurnIds: input.knownTurnIds,
		targetContext: (branchId) =>
			`Turn '${input.turnId}' outcome '${input.outcome}' branch '${branchId}'`,
		emptyBranchError: `Turn '${input.turnId}' outcome '${input.outcome}' contains an empty branch id`,
		duplicateTriggerError: (trigger) =>
			`Turn '${input.turnId}' outcome '${input.outcome}' contains duplicate branch trigger '${trigger}'`,
	});
	return { routes, choose: input.spec.choose };
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
		const { routes, transitions } = compileBranchRoutes({
			branches: input.spec.branches,
			knownTurnIds: input.knownTurnIds,
			targetContext: (branchId) =>
				`Action '${input.actionId}' branch '${branchId}' on turn '${input.turnId}'`,
			emptyBranchError: `Action '${input.actionId}' on turn '${input.turnId}' contains an empty branch id`,
			duplicateTriggerError: (trigger) =>
				`Action '${input.actionId}' on turn '${input.turnId}' contains duplicate branch trigger '${trigger}'`,
		});
		return {
			routing: {
				kind: "branches",
				routes,
				choose: input.spec.choose,
			},
			transitions,
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

/** @internal */
export function getExternalSourceTransitionId(input: {
	/** @internal */
	turnId: TurnId;
	/** @internal */
	source: ExternalActionSource;
	/** @internal */
	index: number;
}): string {
	return `${input.turnId}:${input.source.kind}:${input.index}`;
}

/** @internal */
export function getExternalActionArmingId(input: {
	/** @internal */
	turnId: TurnId;
	/** @internal */
	externalActionId: string;
}): string {
	return `${input.turnId}:${input.externalActionId}`;
}

/** @internal */
export function getExternalActionTransitionTrigger(input: {
	/** @internal */
	externalActionId: string;
}): string {
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
			trigger: getExternalSourceTransitionId({
				turnId: input.turnId,
				source: transition.source,
				index,
			}),
		};
	});
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

async function buildSavePlanResultEffect<TParams, TState>(input: {
	intent: SavePlanResultLifecycleIntent<TParams, TState>;
	execution: ProcessOutcomeExecution<TParams, TState>;
}): Promise<ProcessEffectPlan<TState>> {
	const statePlan = input.intent.state ? await input.intent.state(input.execution) : undefined;
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
}): CompiledOutcomeHandlers<TParams, TState> & {
	transitions: readonly ProcessTurnTransition[];
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
	const routings = new Map<string, CompiledOutcomeRouting<TParams, TState>>();
	for (const [outcome, spec] of outcomeEntries) {
		if (outcome.trim() === "") {
			throw new Error(`Turn '${input.turnId}' declares an empty outcome id`);
		}
		const routing = resolveOutcomeRouting({
			turnId: input.turnId,
			outcome,
			spec,
			knownTurnIds: input.knownTurnIds,
		});
		const target = routing
			? null
			: buildOutcomeTransition(input.turnId, outcome, spec, input.knownTurnIds);
		if (routing) {
			routings.set(outcome, routing);
			for (const route of Object.values(routing.routes)) {
				transitions.push({
					...(route.nextTurnId ? { nextTurnId: route.nextTurnId } : {}),
					...(route.lifecycleStatus ? { lifecycleStatus: route.lifecycleStatus } : {}),
					trigger: route.trigger,
					outcome,
				});
			}
		} else if (target) {
			transitions.push({
				...(target.nextTurnId ? { nextTurnId: target.nextTurnId } : {}),
				...(target.lifecycleStatus ? { lifecycleStatus: target.lifecycleStatus } : {}),
				outcome,
			});
		}
		effects.set(outcome, resolveOutcomeEffect({ spec }));
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
		effects.set(input.turnEnd.outcome, resolveOutcomeEffect({ spec: input.turnEnd }));
	}

	return {
		transitions,
		effects,
		routings,
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
		trigger: getExternalActionTransitionTrigger({ externalActionId: input.externalActionId }),
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
				id: getExternalActionArmingId({ turnId: input.turnId, externalActionId }),
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

/** @internal */
export function resolveHumanTurnView<TParams, TState>(input: {
	/** @internal */
	turnId: TurnId;
	/** @internal */
	turn: HumanTurnDefinition<TParams, TState>;
}): {
	/** @internal */
	actions: readonly HumanTurnActionView[];
	/** @internal */
	externalTriggers: readonly HumanTurnExternalTrigger[];
	/** @internal */
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
	const turnEntries = Object.entries(input.turns);
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
	const executableTurns = new Map<
		TurnId,
		CompiledOutcomeHandlers<TParams, TState> & {
			spec: RoutableTurnDefinition<string, TParams, TState>;
		}
	>();

	for (const [turnId, turnSpec] of turnEntries) {
		if (turnSpec.kind === "llm" || turnSpec.kind === "automatic") {
			const { transitions, effects, routings } = compileTurnOutcomeDefinitions({
				turnId,
				outcomes: turnSpec.outcomes,
				turnEnd: turnSpec.turnEnd,
				knownTurnIds,
			});
			const externalTransitions =
				turnSpec.kind === "automatic" && turnSpec.externalActions
					? deriveHumanTurnActions({
							turnId,
							spec: {
								kind: "human",
								description: turnSpec.description,
								actions: {},
								externalActions: turnSpec.externalActions,
							},
							knownTurnIds,
							turnDefinitionsById,
							requireHumanActions: false,
						}).transitions
					: [];
			turns.set(
				turnId,
				createProcessTurnBinding(turnSpec, [...transitions, ...externalTransitions]),
			);
			executableTurns.set(turnId, { spec: turnSpec, effects, routings });
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
		for (const [turnId, { spec }] of executableTurns) {
			if (manuallyRegisteredTurns.has(turnId)) {
				continue;
			}
			if (spec.kind === "llm") {
				api.turn(turnId, async (run) => {
					await run.turn(spec);
				});
				continue;
			}
			api.turn(turnId, async (run) => {
				await run.complete(await spec.run(run.ctx));
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

		for (const [turnId, { effects, routings }] of executableTurns) {
			api.onTurnOutcome(turnId, async (event, ctx) => {
				const effect = effects.get(event.outcome);
				const routing = routings.get(event.outcome);
				if (!effect && !routing) {
					return;
				}
				const execution = {
					ctx: makeProcessServerRuntimeContext(ctx),
					event,
					turnId,
					outcome: event.outcome,
				};
				const result = effect ? await effect(execution) : undefined;
				let transition: Omit<ServerTransitionRequest<TState>, "state"> | undefined;
				if (routing) {
					const branchId = await routing.choose(execution);
					const route = routing.routes[branchId];
					if (!route) {
						throw new Error(
							`Turn '${turnId}' outcome '${event.outcome}' selected unknown branch '${branchId}'`,
						);
					}
					transition = buildActionTransitionRequest(route);
				}
				await applyProcessEffectPlan({ ctx, result, transition });
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

/** @public */
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
		...(input.runtime ? { runtime: { ...input.runtime } } : {}),
		...(input.resolveStorageSize ? { resolveStorageSize: input.resolveStorageSize } : {}),
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

/** @internal */
type RoutableTurnDefinition<TOutcome extends string, TParams, TState> =
	| LlmTurnDefinition<TOutcome, TParams, TState>
	| AutomaticTurnDefinition<TOutcome, TParams, TState>;

// biome-ignore-start lint/suspicious/noExplicitAny: conditional helper types must match and preserve any routable turn instantiation
/** @internal */
type RoutableOutcome<TTurn> =
	TTurn extends RoutableTurnDefinition<infer TOutcome, any, any> ? TOutcome : never;
/** @internal */
type RoutableParams<TTurn> =
	TTurn extends RoutableTurnDefinition<any, infer TParams, any> ? TParams : never;
/** @internal */
type RoutableState<TTurn> =
	TTurn extends RoutableTurnDefinition<any, any, infer TState> ? TState : never;

/** @internal */
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

/** @public */
export function llmTurn<TParams = unknown, TState = unknown, TOutcome extends string = string>(
	input: Omit<LlmTurnDefinition<TOutcome, TParams, TState>, "kind">,
): LlmTurnDefinition<TOutcome, TParams, TState> {
	return {
		...input,
		kind: "llm",
	};
}

/** @internal */
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

/** @public */
export function humanTurn<TParams = unknown, TState = unknown>(
	input: Omit<HumanTurnDefinition<TParams, TState>, "kind">,
): HumanTurnDefinition<TParams, TState> {
	return {
		...input,
		kind: "human",
	};
}

/** @internal */
export function externalTurn<TParams = unknown, TState = unknown>(
	input: Omit<ExternalTurnDefinition<TParams, TState>, "kind">,
): ExternalTurnDefinition<TParams, TState> {
	return {
		...input,
		kind: "external",
	};
}
