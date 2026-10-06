import {
	assertValidProcessProductName,
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
import { type MappedLlmTurnSpec, mappedCollectTrigger } from "./mapped-turn.js";
import {
	getProcessTurnTransitions,
	markDefinedProcess,
	setProcessTurnTransitions,
} from "./process-definition-internals.js";
import {
	type ProcessGraphSource,
	toProcessGraphView,
	validateProcessGraphProducts,
	validateProcessGraphTurnTransitions,
} from "./process-graph.js";
import type { ServerExtensionEventMap } from "./server-events.js";
import { validateTurnDefinition } from "./turn-semantics.js";
import type { TurnWaitPredicate } from "./turn-wait.js";
import type {
	HumanTurnActionView,
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
	/** Server-side entry condition, evaluated before worker allocation. @public */
	waitFor?: TurnWaitPredicate<TParams, TState>;
	/** External events armed while this LLM turn is selected and waiting. @public */
	externalActions?: Record<string, ProcessHumanTurnExternalActionSpec<TParams, TState>>;
	/** Code-defined model policy purpose. Purpose selections cannot be overridden per launch/action. @internal */
	modelPurpose?: LlmModelPurpose;
	/** Extension-defined scoped settings consumed by this turn. @public */
	executionPurpose?: string;
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
	/** Runs this turn once per frozen item, then collects and routes once. @public */
	forEach?: MappedLlmTurnSpec<TParams, TState>;
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
	/** Server-side entry condition, evaluated before worker allocation. @public */
	waitFor?: TurnWaitPredicate<TParams, TState>;
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
	context: string;
}): Record<string, NormalizedActionRoute> {
	const entries = Object.entries(input.branches);
	if (entries.length === 0) throw new Error(`${input.context} must declare at least one branch`);
	const usedTriggers = new Set<string>();
	return Object.fromEntries(
		compileDeclarations(entries, ([branchId, branchSpec]) => {
			if (branchId.trim() === "") throw new Error(`${input.context} contains an empty branch id`);
			const target = normalizeStaticRouteTarget(
				`${input.context} branch '${branchId}'`,
				branchSpec,
				input.knownTurnIds,
			);
			const trigger = branchSpec.trigger ?? branchId;
			if (usedTriggers.has(trigger))
				throw new Error(`${input.context} contains duplicate branch trigger '${trigger}'`);
			usedTriggers.add(trigger);
			return [branchId, { ...target, trigger }] as const;
		}),
	);
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
		const routes = compileBranchRoutes({
			branches: input.spec.branches,
			knownTurnIds: input.knownTurnIds,
			context: `Action '${input.actionId}' on turn '${input.turnId}'`,
		});
		return {
			routing: {
				kind: "branches",
				routes,
				choose: input.spec.choose,
			},
			transitions: Object.values(routes),
		};
	}
	const target = normalizeStaticRouteTarget(
		`Action '${input.actionId}' on turn '${input.turnId}'`,
		input.spec,
		input.knownTurnIds,
	);
	const route = { ...target, trigger: input.spec.trigger ?? input.actionId };
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
	return compileDeclarations(input.spec.transitions, (transition, index) => {
		const target = normalizeStaticRouteTarget(
			`External turn '${input.turnId}' source '${transition.source.kind}'`,
			transition,
			input.knownTurnIds,
		);
		return {
			...target,
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
	let preview = spec.preview;
	const [transition] = transitions;
	if (!preview && transitions.length === 1 && transition) {
		preview =
			transition.lifecycleStatus !== undefined
				? { kind: "terminal", lifecycleStatus: transition.lifecycleStatus }
				: { kind: "trigger", trigger: transition.trigger };
	}
	if (preview && (spec.preview || spec.schedulable)) {
		validateActionPreviewMatchesTransitions({
			turnId,
			actionId,
			preview,
			transitions,
			context: spec.preview ? "preview" : "scheduling",
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

function withFormState<TState>(
	effect: ProcessEffectPlan<TState> | undefined,
	state: TState,
): ProcessEffectPlan<TState> {
	return {
		...effect,
		state,
		...(effect?.processPatch ? { processPatch: { ...effect.processPatch } } : {}),
		...(effect?.broadcasts ? { broadcasts: [...effect.broadcasts] } : {}),
		...(effect?.emit ? { emit: [...effect.emit] } : {}),
		...(effect?.queueInput ? { queueInput: [...effect.queueInput] } : {}),
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

	const transitions: ProcessTurnTransition[] = [];
	const effects = new Map<string, ProcessOutcomeEffect<TParams, TState> | undefined>();
	const routings = new Map<string, CompiledOutcomeRouting<TParams, TState>>();
	compileDeclarations(outcomeEntries, ([outcome, spec]) => {
		if (outcome.trim() === "") {
			throw new Error(`Turn '${input.turnId}' declares an empty outcome id`);
		}
		if ("branches" in spec) {
			const routes = compileBranchRoutes({
				branches: spec.branches,
				knownTurnIds: input.knownTurnIds,
				context: `Turn '${input.turnId}' outcome '${outcome}'`,
			});
			routings.set(outcome, { routes, choose: spec.choose });
			for (const route of Object.values(routes)) {
				transitions.push({ ...route, outcome });
			}
		} else {
			const target = buildOutcomeTransition(input.turnId, outcome, spec, input.knownTurnIds);
			transitions.push({ ...target, outcome });
		}
		effects.set(outcome, spec.effect);
	});

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
		transitions.push({ ...target, outcome: input.turnEnd.outcome });
		effects.set(input.turnEnd.outcome, input.turnEnd.effect);
	}

	return {
		transitions,
		effects,
		routings,
	};
}

function compileMappedTurnTransitions<TParams, TState>(input: {
	turnId: TurnId;
	spec: LlmTurnDefinition<string, TParams, TState>;
	knownTurnIds: ReadonlySet<TurnId>;
}): readonly ProcessTurnTransition[] {
	const mapped = input.spec.forEach;
	if (!mapped) return [];
	const routing = mapped.routing;
	if (routing.kind === "static") {
		const target = normalizeStaticRouteTarget(
			`Mapped turn '${input.turnId}' collection`,
			routing,
			input.knownTurnIds,
		);
		return [{ ...target, trigger: mappedCollectTrigger() }];
	}
	return compileDeclarations(Object.entries(routing.branches), ([branchId, to]) => {
		if (branchId.trim() === "") {
			throw new Error(`Mapped turn '${input.turnId}' collection contains an empty branch id`);
		}
		const target = normalizeStaticRouteTarget(
			`Mapped turn '${input.turnId}' collection branch '${branchId}'`,
			{ to },
			input.knownTurnIds,
		);
		return { ...target, trigger: mappedCollectTrigger(branchId) };
	});
}

type DerivedHumanTurnAction<TParams, TState> = {
	actionId: string;
	actionSpec: ProcessHumanTurnActionSpec<TParams, TState>;
	routing: CompiledActionRouting<TParams, TState>;
	actionView: HumanTurnActionView;
	externalTriggers: readonly HumanTurnExternalTrigger[];
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
		...target,
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
}): {
	actions: readonly DerivedHumanTurnAction<TParams, TState>[];
	transitions: readonly ProcessTurnTransition[];
} {
	const actionEntries = Object.entries(input.spec.actions);
	const derivedActions: DerivedHumanTurnAction<TParams, TState>[] = [];
	const transitions: ProcessTurnTransition[] = [];
	const actionIdByTrigger = new Map<string, string>();
	compileDeclarations(actionEntries, ([actionId, actionSpec]) => {
		if (actionId.trim() === "") {
			throw new Error(`Human turn '${input.turnId}' declares an empty action id`);
		}
		validateActionPrimaryPrompt(input.turnId, actionId, actionSpec);
		const resolved = resolveActionRouting({
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
			transitions.push({ ...transition });
		}
		const previewAndScheduling = buildActionPreviewAndScheduling(
			input.turnId,
			actionId,
			actionSpec,
			resolved.transitions,
		);
		derivedActions.push({
			actionId,
			actionSpec,
			routing: resolved.routing,
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
	});

	transitions.push(...compileExternalActionTransitions(input, actionIdByTrigger));
	return { actions: derivedActions, transitions };
}

function compileExternalActionTransitions<TParams, TState>(
	input: {
		turnId: TurnId;
		spec: Pick<HumanTurnDefinition<TParams, TState>, "externalActions">;
		knownTurnIds?: ReadonlySet<TurnId>;
		turnDefinitionsById?: ReadonlyMap<TurnId, TurnDefinition<unknown, unknown>>;
	},
	actionIdByTrigger = new Map<string, string>(),
): readonly ProcessTurnTransition[] {
	const entries = Object.entries(input.spec.externalActions ?? {});
	return compileDeclarations(entries, ([externalActionId, actionSpec]) => {
		if (actionSpec.publishInput) {
			if (actionSpec.complete === true || actionSpec.lifecycleStatus !== undefined) {
				throw new Error(
					`Human turn '${input.turnId}' external action '${externalActionId}' cannot publish input on a terminal route`,
				);
			}
			assertValidProcessProductName(actionSpec.publishInput.productName);
			if (actionSpec.publishInput.inputField.trim() === "") {
				throw new Error(
					`Human turn '${input.turnId}' external action '${externalActionId}' publishInput must declare a non-empty inputField`,
				);
			}
		}
		const route = { ...input, externalActionId, spec: actionSpec };
		validateExternalActionPublishedInputTarget(route);
		const transition = resolveExternalActionRoute(route);
		const existingActionId = actionIdByTrigger.get(transition.trigger);
		if (existingActionId) {
			throw new Error(
				`Human turn '${input.turnId}' contains duplicate trigger '${transition.trigger}' across action '${existingActionId}' and external action '${externalActionId}'`,
			);
		}
		actionIdByTrigger.set(transition.trigger, externalActionId);
		return transition;
	});
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
} {
	const derived = deriveHumanTurnActions({
		turnId: input.turnId,
		spec: input.turn,
	});
	return {
		actions: derived.actions.map((action) => action.actionView),
		externalTriggers: derived.actions.flatMap((action) => action.externalTriggers),
	};
}

function compileHumanTurn<TParams, TState>(input: {
	turnId: TurnId;
	spec: HumanTurnDefinition<TParams, TState>;
	knownTurnIds: ReadonlySet<TurnId>;
	turnDefinitionsById: ReadonlyMap<TurnId, TurnDefinition<unknown, unknown>>;
	actionUses: Map<string, CompiledActionUse<TParams, TState>[]>;
}): ProcessTurnBinding<HumanTurnDefinition<TParams, TState>> {
	const derived = deriveHumanTurnActions(input);
	for (const action of derived.actions) {
		const uses = input.actionUses.get(action.actionId) ?? [];
		uses.push({
			turnId: input.turnId,
			label: action.actionSpec.label,
			...(action.actionSpec.form ? { form: action.actionSpec.form } : {}),
			...(action.actionSpec.effect ? { effect: action.actionSpec.effect } : {}),
			routing: action.routing,
		});
		input.actionUses.set(action.actionId, uses);
	}

	return createProcessTurnBinding(input.spec, derived.transitions);
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
		const route = Object.hasOwn(routes, selectedBranchId) ? routes[selectedBranchId] : undefined;
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
	happyPath: readonly TurnId[] | undefined;
	turns: ReadonlyMap<TurnId, ProcessTurnBinding<TurnDefinition<TParams, TState>>>;
}): string[] {
	const errors: string[] = [];
	const happyPath = input.happyPath;
	if (!happyPath || happyPath.length < 2) {
		return errors;
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
				if (next === undefined || !input.turns.has(next)) {
					continue;
				}
				if (next === target) {
					connected = true;
					break;
				}
				if (visited.has(next) || happyPathTurns.has(next)) {
					continue;
				}
				const definition = input.turns.get(next)?.definition;
				if (definition?.kind !== "human") {
					continue;
				}
				visited.add(next);
				queue.push(next);
			}
		}
		if (!connected) {
			errors.push(
				`happy path segment '${source}' -> '${target}' is not connected by declared transitions`,
			);
		}
	}
	return errors;
}

type ProcessDefinitionDeclaration<TParams, TState> = Pick<
	DefinedProcessInput<TParams, TState>,
	"id" | "entry" | "alternateEntries" | "happyPath" | "turns"
>;

class DefinitionDiagnostics {
	readonly errors: string[] = [];

	constructor(private readonly processId: string) {}

	add(message: string, turnId?: TurnId): void {
		const context = `Process '${this.processId}'${turnId === undefined ? "" : `, turn '${turnId}'`}`;
		this.errors.push(`${context}: ${message}`);
	}

	record(error: unknown, turnId?: TurnId): void {
		if (error instanceof AggregateError) {
			for (const cause of error.errors) this.record(cause, turnId);
		} else {
			this.add(error instanceof Error ? error.message : String(error), turnId);
		}
	}

	capture<T>(inspect: () => T, turnId?: TurnId): T | undefined {
		try {
			return inspect();
		} catch (error) {
			this.record(error, turnId);
			return undefined;
		}
	}
}

// Siblings can be inspected independently; their dependent compilation cannot
// proceed until all of them are valid.
function compileDeclarations<TEntry, TResult>(
	entries: readonly TEntry[],
	compile: (entry: TEntry, index: number) => TResult,
): TResult[] {
	const results: TResult[] = [];
	const errors: unknown[] = [];
	for (const [index, entry] of entries.entries()) {
		try {
			results.push(compile(entry, index));
		} catch (error) {
			errors.push(error);
		}
	}
	if (errors.length > 0) {
		throw new AggregateError(
			errors,
			errors.map((error) => (error instanceof Error ? error.message : String(error))).join("; "),
		);
	}
	return results;
}

// Compilation and catalog admission share this inspection. Author callbacks are
// retained as values; inspecting a declaration never executes a process.
function compileProcessDefinition<TParams, TState>(
	input: ProcessDefinitionDeclaration<TParams, TState>,
	retainedTurns?: ReadonlyMap<TurnId, ProcessTurnBinding<TurnDefinition<TParams, TState>>>,
) {
	const diagnostics = new DefinitionDiagnostics(input.id);
	const turnEntries = Object.entries(input.turns);
	const knownTurnIds = new Set(turnEntries.map(([turnId]) => turnId));
	const turnDefinitionsById = new Map<TurnId, TurnDefinition<unknown, unknown>>(
		turnEntries.map(([turnId, turnSpec]) => [turnId, turnSpec as TurnDefinition<unknown, unknown>]),
	);
	if (turnEntries.length === 0) {
		diagnostics.add("must declare at least one turn");
	}
	const seenEntries = new Set<TurnId>();
	for (const turnId of [input.entry, ...(input.alternateEntries ?? [])]) {
		if (seenEntries.has(turnId)) {
			diagnostics.add(`declares duplicate entry turn '${turnId}'`);
		}
		if (!knownTurnIds.has(turnId)) {
			diagnostics.add(`entry turn '${turnId}' is not declared in turns`);
		}
		seenEntries.add(turnId);
	}

	let validHappyPath = true;
	if (input.happyPath) {
		const before = diagnostics.errors.length;
		if (input.happyPath.length === 0) {
			diagnostics.add("declares an empty happy path");
		}
		const seen = new Set<TurnId>();
		for (const turnId of input.happyPath) {
			if (!knownTurnIds.has(turnId)) {
				diagnostics.add(`happy path references undeclared turn '${turnId}'`);
			}
			if (seen.has(turnId)) {
				diagnostics.add(`happy path repeats turn '${turnId}'`);
			}
			seen.add(turnId);
		}
		if (input.happyPath.length > 0 && input.happyPath[0] !== input.entry) {
			diagnostics.add(`happy path must start at the entry turn '${input.entry}'`);
		}
		validHappyPath = before === diagnostics.errors.length;
	}

	const turns = new Map<TurnId, ProcessTurnBinding<TurnDefinition<TParams, TState>>>(
		turnEntries.map(([turnId, definition]) => [turnId, { definition }]),
	);
	const actionUses = new Map<string, CompiledActionUse<TParams, TState>[]>();
	const executableTurns = new Map<
		TurnId,
		CompiledOutcomeHandlers<TParams, TState> & {
			spec: RoutableTurnDefinition<string, TParams, TState>;
		}
	>();
	let validTurns = true;
	let inspectableProducts = true;
	for (const [turnId, turnSpec] of turnEntries) {
		const errors = diagnostics.capture(() => validateTurnDefinition(turnId, turnSpec), turnId);
		if (errors === undefined) {
			validTurns = false;
			inspectableProducts = false;
			continue;
		}
		for (const error of errors) diagnostics.add(error, turnId);
		if (errors.length > 0) {
			validTurns = false;
			continue;
		}
		try {
			const external =
				turnSpec.kind === "external"
					? turnSpec.transitions
					: turnSpec.kind === "human" || turnSpec.kind === "automatic" || turnSpec.kind === "llm"
						? Object.values(turnSpec.externalActions ?? {})
						: [];
			for (const route of external) {
				const target = route.to ? input.turns[route.to] : undefined;
				if ((target?.kind === "llm" || target?.kind === "automatic") && !target.waitFor) {
					validTurns = false;
					diagnostics.add(
						`External transition from '${turnId}' to worker turn '${route.to}' requires .waitFor(...) on the target`,
						turnId,
					);
				}
			}
			const externalTransitions =
				(turnSpec.kind === "llm" || turnSpec.kind === "automatic") && turnSpec.externalActions
					? compileExternalActionTransitions({
							turnId,
							spec: turnSpec,
							knownTurnIds,
							turnDefinitionsById,
						})
					: [];
			if (turnSpec.kind === "llm" && turnSpec.forEach) {
				turns.set(
					turnId,
					createProcessTurnBinding(turnSpec, [
						...compileMappedTurnTransitions({ turnId, spec: turnSpec, knownTurnIds }),
						...externalTransitions,
					]),
				);
				executableTurns.set(turnId, {
					spec: turnSpec,
					effects: new Map(),
					routings: new Map(),
				});
				continue;
			}
			if (turnSpec.kind === "llm" || turnSpec.kind === "automatic") {
				const { transitions, effects, routings } = compileTurnOutcomeDefinitions({
					turnId,
					outcomes: turnSpec.outcomes,
					turnEnd: turnSpec.turnEnd,
					knownTurnIds,
				});
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
				turns.set(turnId, compiled);
				continue;
			}

			const transitions = compileExternalSourceTransitions({
				turnId,
				spec: turnSpec,
				knownTurnIds,
			});
			turns.set(turnId, createProcessTurnBinding(turnSpec, transitions));
		} catch (error) {
			validTurns = false;
			diagnostics.record(error, turnId);
		}
	}

	for (const [actionId, uses] of actionUses) {
		const [firstUse] = uses;
		for (const use of uses.slice(1)) {
			if (!areFormsEquivalent(firstUse.form, use.form)) {
				diagnostics.add(
					`Action '${actionId}' must use the same form on every turn that references it (first declared on '${firstUse.turnId}')`,
					use.turnId,
				);
			}
		}
	}

	if (retainedTurns) {
		for (const [turnId, binding] of retainedTurns) {
			if ("transitions" in binding) {
				diagnostics.add(
					"must declare routing on the turn definition instead of authored transitions",
					turnId,
				);
			}
		}
	}
	// Recompiled declarations and retained transitions must each form a valid graph.
	// Retained routes cannot stand in for metadata that changed after definition.
	for (const graphTurns of retainedTurns ? [turns, retainedTurns] : [turns]) {
		if (!inspectableProducts) continue;
		const graph = diagnostics.capture(() =>
			toProcessGraphView({
				id: input.id,
				entryTurnId: input.entry,
				alternateEntryTurnIds: input.alternateEntries,
				happyPath: input.happyPath,
				turns: graphTurns,
			} as unknown as ProcessGraphSource),
		);
		if (!graph) continue;
		for (const error of validateProcessGraphProducts(graph)) diagnostics.add(error);
		const transitionErrors = validateProcessGraphTurnTransitions(graph);
		for (const error of transitionErrors) diagnostics.add(error);
		// Connectivity depends on successful routing compilation. Do not manufacture
		// disconnected-path errors from turns whose declarations already failed.
		if (validTurns && validHappyPath && transitionErrors.length === 0) {
			for (const error of validateHappyPathConnectivity({
				happyPath: input.happyPath,
				turns: graphTurns,
			}))
				diagnostics.add(error);
		}
	}

	return { turns, actionUses, executableTurns, errors: [...new Set(diagnostics.errors)] };
}

/** Recheck declaration metadata and retained graph facts without executing author callbacks. @internal */
export function validateProcessDefinition<TParams, TState>(
	process: ExtensionProcessDefinition<TParams, TState>,
): readonly string[] {
	return compileProcessDefinition(
		{
			id: process.id,
			entry: process.entryTurnId,
			alternateEntries: process.alternateEntryTurnIds,
			happyPath: process.happyPath,
			turns: Object.fromEntries(
				[...process.turns].map(([id, binding]) => [id, binding.definition]),
			),
		},
		process.turns,
	).errors;
}

function buildDefinedProcess<TParams, TState>(
	input: DefinedProcessInput<TParams, TState>,
): Pick<ExtensionProcessDefinition<TParams, TState>, "turns" | "worker" | "server"> {
	const { turns, actionUses, executableTurns, errors } = compileProcessDefinition(input);
	if (errors.length > 0) throw new Error(errors.join("; "));

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
					const result = formState ? withFormState(effectResult, formState) : effectResult;
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
					const branchId = await routing.choose({
						...execution,
						ctx: {
							...execution.ctx,
							state: result?.state !== undefined ? result.state : execution.ctx.state,
						},
					});
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
): ExtensionProcessDefinition<TParams, TState> {
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
