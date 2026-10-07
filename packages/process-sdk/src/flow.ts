import path from "node:path";
import {
	assertValidProcessProductName,
	humanizeProcessLabel,
	normalizeStringArray,
	type ProcessInstance,
	type ProcessProject,
	type ProcessTurnStartSelection,
	type ProcessTurnTerminalLifecycleStatus,
	type TurnId,
	type TurnProgressReport,
	trimString,
} from "@leitwerk-dev/domain";
import type {
	AutomaticTurnDefinition,
	DefinedProcessInput,
	ExternalTurnDefinition,
	HumanTurnDefinition,
	HumanTurnOperatorAttention,
	LlmModelPurpose,
	LlmTurnDefinition,
	ProcessEffectPlan,
	ProcessHumanTurnActionSpec,
	ProcessHumanTurnExternalActionSpec,
	ProcessOutcomeEffect,
	ProcessOutcomeExecution,
	ProcessRuntimeTurnContext,
	ProcessToolOutcomeSpec,
	ProcessTurnEndSpec,
	TurnDefinition,
	TurnDefinitionRecord,
} from "./define-process.js";
import { defineProcess } from "./define-process.js";
import type {
	Codec,
	ExtensionProcessDefinition,
	ExternalActionSource,
	ExternalSourceEffect,
	ExternalSourceEffectContext,
	FormDefinition,
	ProcessActionDefinition,
	ProcessLauncherAPI,
	ProcessLauncherDefinition,
	ProcessWatcherAPI,
	ProcessWatcherDefinition,
	ServerProcessAPI,
	UiProcessAPI,
	WorkerCompleteInput,
} from "./extension-api.js";
import { isPathInside } from "./fs-utils.js";
import type {
	MappedCollect,
	MappedCollectRouting,
	MappedItemYield,
	MappedLlmTurnSpec,
	MappedTurnItemContext,
	MappedTurnServerContext,
} from "./mapped-turn.js";
import type { TurnWaitPredicate } from "./turn-wait.js";
import type { OutcomeToolParameterSpec, PiBuiltInToolName, ProcessPiConfig } from "./types.js";

/** @public */
type MaybePromise<T> = T | Promise<T>;

/** @internal */
export const DEFAULT_PLAN_RESULT_OUTCOME_ID = "plan_saved" as const;
/** @internal */
export const DEFAULT_FLOW_PRODUCT_NAME = "default" as const;
const ASSISTANT_OUTPUT_TURN_RESULT = { mode: "assistant_output", required: true } as const;
const OUTCOME_TOOL_MARKDOWN_PARAMETER_NAME = "markdown" as const;
const OUTCOME_TOOL_ARGUMENT_TURN_RESULT = {
	mode: "outcome_tool_argument",
	parameterName: OUTCOME_TOOL_MARKDOWN_PARAMETER_NAME,
	required: true,
} as const;

/** @public */
export interface FlowLlmTurn<
	TParams = unknown,
	TState = unknown,
	TOutcome extends string = string,
> {
	/** @public */
	id: TurnId;
	/** @public */
	definition: LlmTurnDefinition<TOutcome, TParams, TState>;
}

/** @public */
export interface FlowAutomaticTurn<
	TParams = unknown,
	TState = unknown,
	TOutcome extends string = string,
> {
	/** @public */
	id: TurnId;
	/** @public */
	definition: AutomaticTurnDefinition<TOutcome, TParams, TState>;
}

/** @public */
export interface FlowHumanTurn<TParams = unknown, TState = unknown> {
	/** @public */
	id: TurnId;
	/** @public */
	definition: HumanTurnDefinition<TParams, TState>;
}

/** @public */
export interface FlowExternalTurn<TParams = unknown, TState = unknown> {
	/** @public */
	id: TurnId;
	/** @public */
	definition: ExternalTurnDefinition<TParams, TState>;
}

/** @public */
export type FlowTurn<TParams = unknown, TState = unknown> =
	| FlowLlmTurn<TParams, TState, string>
	| FlowAutomaticTurn<TParams, TState, string>
	| FlowHumanTurn<TParams, TState>
	| FlowExternalTurn<TParams, TState>
	| {
			/** @public */
			id: TurnId;
			/** @public */
			definition: TurnDefinition<TParams, TState>;
	  };

/** @internal */
export interface PlanFieldOptions {
	/** @internal */
	description?: string;
	/** @internal */
	requiredErrorCode?: string;
}

/** @internal */
export interface PlanAcceptanceCriteriaOptions extends PlanFieldOptions {
	/** @internal */
	minItems?: number;
	/** @internal */
	minItemsErrorCode?: string;
}

export interface PlanSavedStateInput<TParams = unknown, TState = unknown> {
	effect: ProcessOutcomeEffect<TParams, TState>;
}

/** @public */
export interface FlowRepoContext {
	/** @internal */
	key: string;
	/** @public */
	fsPath: string;
	/** @internal */
	workspaceClonePath: string;
	/** @public */
	baseBranch: string;
	/** @public */
	workBranch: string;
	/** @internal */
	locator: string;
}

/** @public */
export interface FlowRepoLookup {
	/** @public */
	get(key: string): FlowRepoContext;
	/** @internal */
	optional(key: string): FlowRepoContext | undefined;
	/** @internal */
	all(): FlowRepoContext[];
}

/** @public */
export type FlowPromptContext<
	TParams = unknown,
	TState = unknown,
	TConsumedProducts extends string = string,
	TPrepared = undefined,
> = {
	/** @internal */
	process: ProcessInstance;
	/** @internal */
	projects: readonly ProcessProject[];
	/** @public */
	params: TParams;
	/** @public */
	state: TState;
	/** @internal */
	workspaceRoot?: string;
	/** @internal */
	prompts: {
		/** @internal */
		initial: string;
	};
	/** @public */
	input: Readonly<Partial<Record<TConsumedProducts, string>>>;
	/** @internal */
	repo: FlowRepoLookup;
} & ([TPrepared] extends [undefined]
	? {
			/** @internal */
			prepared?: undefined;
		}
	: {
			/** @internal */
			prepared: TPrepared;
		});

/** @public */
export interface FlowAutomaticRunContext<TParams = unknown, TState = unknown> {
	/** @public */
	process: ProcessInstance;
	/** @public */
	projects: readonly ProcessProject[];
	/** @public */
	params: TParams;
	/** @public */
	state: TState;
	/** @public */
	workspaceRoot?: string;
	/** @public */
	repo: FlowRepoLookup;
	/** @public */
	callIntegrationTool(name: string, args: Record<string, unknown>): Promise<unknown>;
	/** @public */
	reportProgress(report: TurnProgressReport): void;
}

/** @public */
export type FlowLlmPreparationContext<
	TParams = unknown,
	TState = unknown,
> = FlowAutomaticRunContext<TParams, TState>;

/** @public */
interface FlowOutcomeEffectContext<TParams = unknown, TState = unknown> {
	/** @public */
	process: ProcessInstance;
	/** @internal */
	projects: readonly ProcessProject[];
	/** @internal */
	params: TParams;
	/** @public */
	state: TState;
	/** @internal */
	output: {
		/** @internal */
		content: string | null;
	} | null;
}

/** @public */
export interface FlowLlmOutcomeEffectContext<TParams = unknown, TState = unknown>
	extends FlowOutcomeEffectContext<TParams, TState> {}

/** @public */
export interface FlowAutomaticOutcomeEffectContext<TParams = unknown, TState = unknown>
	extends FlowOutcomeEffectContext<TParams, TState> {}

/** @internal */
export interface FlowExternalSourceContext<
	TParams = unknown,
	TState = unknown,
	TEvent = unknown,
	TInput extends Record<string, unknown> = Record<string, unknown>,
> extends ExternalSourceEffectContext<TParams, TState, TEvent, TInput> {}

/** @public */
type FlowOutcomeEffectInput<TParams, TState, TContext> = {
	/** @public */
	ctx: TContext;
	/** @public */
	event: ProcessOutcomeExecution<TParams, TState>["event"];
	/** @internal */
	turnId: TurnId;
	/** @internal */
	outcome: string;
};

/** @public */
type FlowOutcomeEffect<TParams, TState, TContext> = (
	input: FlowOutcomeEffectInput<TParams, TState, TContext>,
) => MaybePromise<ProcessEffectPlan<TState> | undefined>;

/** @public */
type FlowOutcomeStateEffect<TParams, TState, TContext> = (
	input: FlowOutcomeEffectInput<TParams, TState, TContext>,
) => MaybePromise<TState>;

function normalizeProductName(productName: string): string {
	assertValidProcessProductName(productName);
	return productName;
}

function toRequiredErrorCode(name: string): string {
	const snake = name
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/[^a-zA-Z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.toLowerCase();
	return `${snake || "value"}_required`;
}

function readInitialPrompt<TParams>(params: TParams): string {
	if (typeof params === "object" && params !== null && "prompt" in params) {
		const value = (params as { prompt?: unknown }).prompt;
		if (typeof value === "string") {
			return value;
		}
	}
	return "";
}

function safeJoinInside(parent: string, childPath: string, context: string): string {
	const parentPath = path.resolve(parent);
	const targetPath = path.resolve(parentPath, childPath);
	if (!isPathInside(parentPath, targetPath)) {
		throw new Error(`${context} resolves outside '${parentPath}'`);
	}
	return targetPath;
}

function resolveSafeProjectWorkspacePath(key: string): {
	relativePath: string;
	workspaceClonePath: string;
} {
	if (path.isAbsolute(key)) {
		throw new Error(`Flow context project key '${key}' must be a relative workspace path`);
	}
	const virtualWorkspaceRoot = path.resolve(path.sep, "__leitwerk_process_workspace__");
	const virtualTarget = safeJoinInside(
		virtualWorkspaceRoot,
		key,
		`Flow context project key '${key}'`,
	);
	const relativePath = path.relative(virtualWorkspaceRoot, virtualTarget);
	return {
		relativePath,
		workspaceClonePath: `./${relativePath.split(path.sep).join("/")}`,
	};
}

function resolveRepoByKey(input: {
	projects: readonly ProcessProject[];
	workspaceRoot?: string;
	key: string;
}): FlowRepoContext | undefined {
	const key = input.key.trim();
	if (!key) {
		throw new Error("Flow repo lookup requires a non-empty project key");
	}
	const matches = input.projects.filter((project) => project.key.trim() === key);
	if (matches.length === 0) return undefined;
	if (matches.length > 1) {
		throw new Error(`Flow context found duplicate project key '${key}'`);
	}
	const project = matches[0];
	const baseBranch = project.baseBranch.trim();
	if (!baseBranch) {
		throw new Error(`Flow context project '${key}' has no base branch`);
	}
	const workBranch = (project.workBranch ?? project.baseBranch).trim();
	if (!workBranch) {
		throw new Error(`Flow context project '${key}' has no work branch`);
	}
	const workspacePath = resolveSafeProjectWorkspacePath(key);
	return {
		key,
		workspaceClonePath: workspacePath.workspaceClonePath,
		fsPath:
			typeof input.workspaceRoot === "string" && input.workspaceRoot.trim() !== ""
				? safeJoinInside(
						input.workspaceRoot,
						workspacePath.relativePath,
						`Flow context project '${key}' workspace path`,
					)
				: workspacePath.workspaceClonePath,
		baseBranch,
		workBranch,
		locator: project.repoLocator,
	};
}

function createFlowRepoLookup(input: {
	projects: readonly ProcessProject[];
	workspaceRoot?: string;
}): FlowRepoLookup {
	const get = (key: string): FlowRepoContext => {
		const repo = resolveRepoByKey({ ...input, key });
		if (repo) return repo;
		const availableKeys = input.projects
			.map((project) => project.key.trim())
			.filter((key) => key !== "")
			.join(", ");
		throw new Error(
			`Flow context requires project '${key.trim()}', but this process has no project with that key${
				availableKeys ? ` (available: ${availableKeys})` : ""
			}`,
		);
	};
	return {
		get,
		optional: (key) => resolveRepoByKey({ ...input, key }),
		all: () => input.projects.map((project) => get(project.key)),
	};
}

function createFlowContextBase<TParams, TState>(ctx: ProcessRuntimeTurnContext<TParams, TState>) {
	const { process, projects, params, state, workspaceRoot } = ctx;
	return {
		process,
		projects,
		params,
		state,
		...(workspaceRoot ? { workspaceRoot } : {}),
		repo: createFlowRepoLookup({ projects, workspaceRoot }),
	};
}

/** @internal */
export function createFlowPromptContext<
	TParams,
	TState,
	TConsumedProducts extends string = string,
	TPrepared = undefined,
>(
	ctx: ProcessRuntimeTurnContext<TParams, TState>,
	consumedProducts: readonly TConsumedProducts[],
	optionalConsumedProducts: readonly string[] = [],
): FlowPromptContext<TParams, TState, TConsumedProducts, TPrepared> {
	const productInput: Record<string, string> = {};
	const required = new Set<string>(consumedProducts);
	for (const productName of new Set([...required, ...optionalConsumedProducts])) {
		const markdown = ctx.turnResultMarkdownByProduct?.[productName];
		if (typeof markdown === "string" && markdown.trim() !== "") {
			productInput[productName] = markdown;
		} else if (required.has(productName)) {
			throw new Error(
				`Flow prompt context requires product '${productName}' markdown, but the worker payload did not provide it`,
			);
		}
	}
	return {
		...createFlowContextBase(ctx),
		prompts: {
			initial: readInitialPrompt(ctx.params),
		},
		input: productInput as Partial<Record<TConsumedProducts, string>>,
		prepared: ctx.prepared as TPrepared,
	} as FlowPromptContext<TParams, TState, TConsumedProducts, TPrepared>;
}

/** @internal */
export function createFlowAutomaticRunContext<TParams, TState>(
	ctx: ProcessRuntimeTurnContext<TParams, TState>,
): FlowAutomaticRunContext<TParams, TState> {
	return {
		...createFlowContextBase(ctx),
		callIntegrationTool(name, args) {
			if (!ctx.callIntegrationTool) {
				throw new Error(`Automatic integration tool '${name}' is unavailable`);
			}
			return ctx.callIntegrationTool(name, args);
		},
		reportProgress(report) {
			ctx.reportProgress?.(report);
		},
	};
}

function wrapOutcomeCallback<TParams, TState, TResult>(
	callback: (
		input: FlowOutcomeEffectInput<TParams, TState, FlowOutcomeEffectContext<TParams, TState>>,
	) => TResult,
): (execution: ProcessOutcomeExecution<TParams, TState>) => TResult {
	return (execution) =>
		callback({
			ctx: {
				process: execution.ctx.process,
				projects: execution.ctx.projects,
				params: execution.ctx.params,
				state: execution.ctx.state,
				output:
					typeof execution.event.turnResultMarkdown === "string"
						? { content: execution.event.turnResultMarkdown }
						: null,
			},
			event: execution.event,
			turnId: execution.turnId,
			outcome: execution.outcome,
		});
}

/** @public */
class RouteAndEffectBuilder<TParams, TState, TContext> {
	/** @internal */
	protected target: FlowTargetSpec = null;
	/** @internal */
	protected flowEffect: FlowOutcomeEffect<TParams, TState, TContext> | undefined;

	/** @internal */
	protected setTarget(next: FlowTargetSpec): this {
		if (this.target && next) {
			throw new Error("Flow route already declares a target");
		}
		this.target = next;
		return this;
	}

	/** @public */
	to(turnId: TurnId): this {
		return this.setTarget({ to: turnId });
	}

	/** @public */
	complete(): this {
		return this.setTarget({ complete: true });
	}

	/** @public */
	lifecycleStatus(status: ProcessTurnTerminalLifecycleStatus): this {
		return this.setTarget({ lifecycleStatus: status });
	}

	/** @internal */
	stay(): this {
		this.target = null;
		return this;
	}

	/** @public */
	state(fn: FlowOutcomeStateEffect<TParams, TState, TContext>): this {
		this.flowEffect = async (input) => ({ state: await fn(input) });
		return this;
	}

	/** @public */
	effect(fn: FlowOutcomeEffect<TParams, TState, TContext>): this {
		this.flowEffect = fn;
		return this;
	}

	/** @internal */
	getEffect(): FlowOutcomeEffect<TParams, TState, TContext> | undefined {
		return this.flowEffect;
	}

	/** @internal */
	hasRoute(): boolean {
		return this.target !== null;
	}

	/** @internal */
	buildRouteTarget(): Pick<ProcessTurnEndSpec, "to" | "complete" | "lifecycleStatus"> {
		return { ...this.target };
	}
}

/** @internal */
export type FlowTargetSpec =
	| {
			/** @internal */
			to: TurnId;
	  }
	| {
			/** @internal */
			complete: true;
	  }
	| {
			/** @internal */
			lifecycleStatus: ProcessTurnTerminalLifecycleStatus;
	  }
	| null;

/** @public */
interface ParameterOptions extends Partial<Omit<OutcomeToolParameterSpec, "type" | "description">> {
	/** @public */
	description?: string;
	/** @internal */
	requiredErrorCode?: string;
}

/** @public */
interface ArrayParameterOptions extends ParameterOptions {
	/** @public */
	items?: OutcomeToolParameterSpec["items"];
}

/** @internal */
interface EnumParameterOptions extends ParameterOptions {
	/** @internal */
	values?: readonly string[];
}

/** @public */
interface MarkdownParameterOptions extends ParameterOptions {
	/** @public */
	publish?: true;
}

function isStringArray(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/** @public */
class OutcomeParametersBuilder {
	/** @internal */
	protected outcomeDescription: string | null = null;
	/** @internal */
	protected parameters: Record<string, OutcomeToolParameterSpec> = {};
	/** @internal */
	protected summaryParameter: string | null = null;

	/** Optional concise result publication, separate from the full Markdown. @public */
	resultSummary(name = "resultSummary"): this {
		this.summaryParameter = name;
		return this.parameter(name, {
			type: "string",
			description: "Concise summary of this attempt’s outcome.",
		});
	}

	/** @internal */
	protected buildParameterSpec(
		kind: string,
	): Pick<ProcessToolOutcomeSpec, "description" | "parameters" | "resultSummaryParameter"> {
		if (!this.outcomeDescription) throw new Error(`${kind} must declare .description(...)`);
		return {
			description: this.outcomeDescription,
			parameters: this.parameters,
			...(this.summaryParameter ? { resultSummaryParameter: this.summaryParameter } : {}),
		};
	}

	/** @public */
	description(text: string): this {
		this.outcomeDescription = text;
		return this;
	}

	/** @internal */
	parameter(name: string, spec: OutcomeToolParameterSpec): this {
		if (name.trim() === "") {
			throw new Error("Outcome parameter name must be non-empty");
		}
		this.parameters[name] = {
			...spec,
			description: spec.description ?? "",
		};
		return this;
	}

	private withRequired(
		name: string,
		options: string | ParameterOptions,
	): ParameterOptions & { description?: string } {
		const resolved = typeof options === "string" ? { description: options } : options;
		return {
			...resolved,
			required: true,
			requiredErrorCode: resolved.requiredErrorCode ?? toRequiredErrorCode(name),
		};
	}

	/** @internal */
	protected typedParameter(
		name: string,
		type: OutcomeToolParameterSpec["type"],
		options: string | ArrayParameterOptions = {},
	): this {
		const resolved = typeof options === "string" ? { description: options } : options;
		return this.parameter(name, {
			...resolved,
			type,
			description: resolved.description ?? "",
			...(type === "array" ? { items: resolved.items ?? { type: "string" } } : {}),
		});
	}

	/** @public */
	string(name: string, options: string | ParameterOptions = {}): this {
		return this.typedParameter(name, "string", options);
	}

	/** @public */
	requiredString(name: string, options: string | ParameterOptions = {}): this {
		return this.typedParameter(name, "string", this.withRequired(name, options));
	}

	/** @internal */
	number(name: string, options: string | ParameterOptions = {}): this {
		return this.typedParameter(name, "number", options);
	}

	/** @public */
	requiredNumber(name: string, options: string | ParameterOptions = {}): this {
		return this.typedParameter(name, "number", this.withRequired(name, options));
	}

	/** @internal */
	boolean(name: string, options: string | ParameterOptions = {}): this {
		return this.typedParameter(name, "boolean", options);
	}

	/** @public */
	requiredBoolean(name: string, options: string | ParameterOptions = {}): this {
		return this.typedParameter(name, "boolean", this.withRequired(name, options));
	}

	/** @internal */
	stringArray(name: string, options: string | ArrayParameterOptions = {}): this {
		return this.typedParameter(name, "array", options);
	}

	/** @public */
	requiredStringArray(name: string, options: string | ArrayParameterOptions = {}): this {
		return this.typedParameter(name, "array", this.withRequired(name, options));
	}

	/** @internal */
	enum(name: string, valuesOrOptions: readonly string[] | EnumParameterOptions): this {
		const resolved: EnumParameterOptions = isStringArray(valuesOrOptions)
			? { values: [...valuesOrOptions] }
			: valuesOrOptions;
		const { values = [], ...options } = resolved;
		return this.parameter(name, {
			...options,
			type: "string",
			description: options.description ?? "",
			enum: [...values],
		});
	}

	/** @public */
	object(name: string, options: string | ParameterOptions = {}): this {
		return this.typedParameter(name, "object", options);
	}

	/** @internal */
	array(name: string, options: string | ArrayParameterOptions = {}): this {
		return this.typedParameter(name, "array", options);
	}

	/** @public */
	requiredArray(name: string, options: string | ArrayParameterOptions = {}): this {
		return this.typedParameter(name, "array", this.withRequired(name, options));
	}
}

/** @public */
class ParameterizedOutcomeBuilder<TParams, TState, TContext> extends OutcomeParametersBuilder {
	private readonly route = new RouteAndEffectBuilder<TParams, TState, TContext>();
	private publishedMarkdownParameter: string | null = null;

	/** @public */
	to(turnId: TurnId): this {
		this.route.to(turnId);
		return this;
	}

	/** @public */
	complete(): this {
		this.route.complete();
		return this;
	}

	/** @public */
	lifecycleStatus(status: ProcessTurnTerminalLifecycleStatus): this {
		this.route.lifecycleStatus(status);
		return this;
	}

	/** @internal */
	stay(): this {
		this.route.stay();
		return this;
	}

	/** @public */
	state(fn: FlowOutcomeStateEffect<TParams, TState, TContext>): this {
		this.route.state(fn);
		return this;
	}

	/** @public */
	effect(fn: FlowOutcomeEffect<TParams, TState, TContext>): this {
		this.route.effect(fn);
		return this;
	}

	/** @internal */
	hasRoute(): boolean {
		return this.route.hasRoute();
	}

	/** @internal */
	protected get flowEffect(): FlowOutcomeEffect<TParams, TState, TContext> | undefined {
		return this.route.getEffect();
	}

	/** @internal */
	protected buildRouteTarget() {
		return this.route.buildRouteTarget();
	}

	/** @internal */
	protected override buildParameterSpec(kind: string): ProcessToolOutcomeSpec<TParams, TState> {
		return {
			...super.buildParameterSpec(kind),
			...(this.publishedMarkdownParameter
				? {
						publishedProduct: this.publishedMarkdownParameter,
						turnResultMarkdownParameter: this.publishedMarkdownParameter,
					}
				: {}),
		};
	}

	/** @public */
	markdown(name: string, options: string | MarkdownParameterOptions = {}): this {
		const resolved = typeof options === "string" ? { description: options } : options;
		const { publish, ...parameterOptions } = resolved;
		if (publish) {
			if (this.publishedMarkdownParameter && this.publishedMarkdownParameter !== name) {
				throw new Error("Outcome can publish only one markdown parameter");
			}
			normalizeProductName(name);
			this.publishedMarkdownParameter = name;
		}
		return this.typedParameter(name, "string", {
			...parameterOptions,
			required: publish ? true : resolved.required,
			requiredErrorCode: resolved.requiredErrorCode ?? (publish ? `${name}_required` : undefined),
		});
	}
}

/** @public */
export class OutcomeToolBuilder<
	TParams = unknown,
	TState = unknown,
> extends ParameterizedOutcomeBuilder<
	TParams,
	TState,
	FlowLlmOutcomeEffectContext<TParams, TState>
> {
	private stateRouting:
		| {
				branches: Record<string, TurnId>;
				choose: (
					input: FlowOutcomeEffectInput<
						TParams,
						TState,
						FlowLlmOutcomeEffectContext<TParams, TState>
					>,
				) => MaybePromise<string>;
		  }
		| undefined;

	/** @public */
	routeByState(
		branches: Record<string, TurnId>,
		choose: (
			input: FlowOutcomeEffectInput<TParams, TState, FlowLlmOutcomeEffectContext<TParams, TState>>,
		) => MaybePromise<string>,
	): this {
		if (this.hasRoute() || this.stateRouting) {
			throw new Error("State-routed outcome cannot declare another route");
		}
		if (Object.keys(branches).length === 0) {
			throw new Error("State-routed outcome must declare at least one branch");
		}
		this.stateRouting = { branches, choose };
		return this;
	}

	/** @internal */
	build(): ProcessToolOutcomeSpec<TParams, TState> {
		const parameters = this.buildParameterSpec("LLM outcome tool");
		if (this.stateRouting && this.hasRoute()) {
			throw new Error("State-routed outcome cannot declare another route");
		}
		const stateRouting = this.stateRouting;
		return {
			...parameters,
			...(stateRouting
				? {
						branches: Object.fromEntries(
							Object.entries(stateRouting.branches).map(([branchId, turnId]) => [
								branchId,
								{ to: turnId },
							]),
						),
						choose: wrapOutcomeCallback((input) => stateRouting.choose(input)),
					}
				: this.buildRouteTarget()),
			...(this.flowEffect ? { effect: wrapOutcomeCallback(this.flowEffect) } : {}),
		};
	}
}

/** @public */
export class AutomaticOutcomeBuilder<
	TParams = unknown,
	TState = unknown,
> extends ParameterizedOutcomeBuilder<
	TParams,
	TState,
	FlowAutomaticOutcomeEffectContext<TParams, TState>
> {
	private waits = false;

	/** @public */
	wait(): this {
		if (this.hasRoute()) throw new Error("Waiting outcome cannot declare another route");
		this.waits = true;
		return this;
	}

	/** @internal */
	build(): ProcessToolOutcomeSpec<TParams, TState> {
		const parameters = this.buildParameterSpec("Automatic outcome");
		const configuredEffect = this.flowEffect ? wrapOutcomeCallback(this.flowEffect) : undefined;
		const effect = this.waits
			? async (
					execution: Parameters<NonNullable<ProcessToolOutcomeSpec<TParams, TState>["effect"]>>[0],
				) => {
					const result = configuredEffect ? await configuredEffect(execution) : undefined;
					return {
						...result,
						processPatch: { ...(result?.processPatch ?? {}), lifecycleStatus: "waiting" as const },
					};
				}
			: configuredEffect;
		return {
			...parameters,
			...this.buildRouteTarget(),
			...(effect ? { effect } : {}),
		};
	}
}

/** @internal */
export class PlanResultBuilder<TParams = unknown, TState = unknown> extends RouteAndEffectBuilder<
	TParams,
	TState,
	FlowLlmOutcomeEffectContext<TParams, TState>
> {
	private resultDescription = "The candidate plan is ready for operator review";
	private summarySpec: OutcomeToolParameterSpec | null = null;
	private acceptanceCriteriaSpec: OutcomeToolParameterSpec | null = null;
	private reviewTurnId: TurnId | null = null;

	/** @internal */
	description(text: string): this {
		this.resultDescription = text;
		return this;
	}

	/** @internal */
	summary(options: string | PlanFieldOptions = {}): this {
		const resolved = typeof options === "string" ? { description: options } : options;
		this.summarySpec = {
			type: "string",
			description: resolved.description ?? "Short summary of the proposed plan",
			required: true,
			requiredErrorCode: resolved.requiredErrorCode ?? "summary_required",
		};
		return this;
	}

	/** @internal */
	acceptanceCriteria(options: string | PlanAcceptanceCriteriaOptions = {}): this {
		const resolved = typeof options === "string" ? { description: options } : options;
		this.acceptanceCriteriaSpec = {
			type: "array",
			description: resolved.description ?? "Acceptance criteria for the requested change",
			items: { type: "string" },
			required: true,
			requiredErrorCode: resolved.requiredErrorCode ?? "acceptance_criteria_required",
			minItems: resolved.minItems ?? 1,
			minItemsErrorCode: resolved.minItemsErrorCode ?? "acceptance_criteria_required",
		};
		return this;
	}

	/** @internal */
	review(turnId: TurnId): this {
		this.reviewTurnId = turnId;
		return this.setTarget({ to: turnId });
	}

	/** @internal */
	buildOutcome(): ProcessToolOutcomeSpec<TParams, TState> {
		if (!this.summarySpec) {
			throw new Error("plan result must declare .summary(...)");
		}
		if (!this.acceptanceCriteriaSpec) {
			throw new Error("plan result must declare .acceptanceCriteria(...)");
		}
		if (!this.reviewTurnId) {
			throw new Error("plan result must declare .review(turnId)");
		}
		const stateEffect = this.flowEffect ? wrapOutcomeCallback(this.flowEffect) : undefined;
		return {
			description: this.resultDescription,
			parameters: {
				summary: this.summarySpec,
				acceptanceCriteria: this.acceptanceCriteriaSpec,
			},
			to: this.reviewTurnId,
			async effect(execution) {
				const plan = await stateEffect?.(execution);
				const planRevision = execution.ctx.process.planRevision + 1;
				const summary = trimString(execution.event.params.summary);
				const acceptanceCriteria = normalizeStringArray(execution.event.params.acceptanceCriteria);
				const planMarkdown =
					typeof execution.event.turnResultMarkdown === "string"
						? execution.event.turnResultMarkdown
						: trimString(execution.event.params.planMarkdown);
				return {
					...plan,
					processPatch: { ...plan?.processPatch, planRevision },
					broadcasts: [
						...(plan?.broadcasts ?? []),
						{
							type: "plan.updated",
							payload: { planRevision, reviewState: "awaiting_approval", approved: false, summary },
						},
					],
					emit: [
						...(plan?.emit ?? []),
						{
							type: DEFAULT_PLAN_RESULT_OUTCOME_ID,
							data: { planRevision, summary, planMarkdown, acceptanceCriteria },
						},
					],
				};
			},
		};
	}
}

/** @public */
export class LlmTurnEndBuilder<TParams = unknown, TState = unknown>
	extends RouteAndEffectBuilder<TParams, TState, FlowLlmOutcomeEffectContext<TParams, TState>>
	implements FlowLlmTurn<TParams, TState, string>
{
	/** @internal */
	protected readonly builderName: string = "LLM turn end";

	/** @internal */
	constructor(
		private readonly outcomeId: string,
		private readonly parent?: FlowLlmTurn<TParams, TState, string>,
	) {
		super();
		if (outcomeId.trim() === "") throw new Error("LLM turn end outcome must be non-empty");
	}

	private get turn(): FlowLlmTurn<TParams, TState, string> {
		if (!this.parent) throw new Error(`${this.builderName} builder is not attached to a turn`);
		return this.parent;
	}

	/** @internal */
	get id(): TurnId {
		return this.turn.id;
	}

	/** @internal */
	get definition(): LlmTurnDefinition<string, TParams, TState> {
		return this.turn.definition;
	}

	/** @internal */
	build(): ProcessTurnEndSpec<TParams, TState, string> {
		const effect = this.flowEffect ? wrapOutcomeCallback(this.flowEffect) : undefined;
		return {
			outcome: this.outcomeId,
			...this.buildRouteTarget(),
			...(effect ? { effect } : {}),
		};
	}
}

/** @public */
export class PublishedResultBuilder<TParams = unknown, TState = unknown> extends LlmTurnEndBuilder<
	TParams,
	TState
> {
	/** @internal */
	protected override readonly builderName = "Published result";

	/** @internal */
	buildTurnEnd(): ProcessTurnEndSpec<TParams, TState, string> {
		return this.build();
	}
}

/** @public */
abstract class DescribedTurnBuilder {
	/** @internal */
	protected turnDescription: string | null = null;

	/** @internal */
	constructor(
		/** @internal */
		protected readonly turnId: TurnId,
	) {}

	/** @internal */
	get id(): TurnId {
		return this.turnId;
	}

	/** @public */
	description(description: string): this {
		this.turnDescription = description;
		return this;
	}
}

type StoredExternalActionBuilder<TParams, TState> = ExternalActionBuilder<
	TParams,
	TState,
	unknown,
	Record<string, unknown>
>;

/** @public */
abstract class ExternalActionTurnBuilder<TParams, TState> extends DescribedTurnBuilder {
	/** @internal */
	protected abstract readonly turnKind: "LLM" | "Automatic" | "Human";
	private externalActionBuilders = new Map<string, StoredExternalActionBuilder<TParams, TState>>();

	/** @public */
	externalAction<
		TEvent = unknown,
		TInput extends Record<string, unknown> = Record<string, unknown>,
	>(
		externalActionId: string,
		source: ExternalActionSource<TParams, TState, TEvent, TInput>,
		configure: (
			external: ExternalActionBuilder<TParams, TState, TEvent, TInput>,
		) => ExternalActionBuilder<TParams, TState, TEvent, TInput> | undefined,
	): this {
		if (this.externalActionBuilders.has(externalActionId)) {
			throw new Error(
				`${this.turnKind} turn '${this.turnId}' declares duplicate external action '${externalActionId}'`,
			);
		}
		const builder = new ExternalActionBuilder(externalActionId, source);
		configure(builder);
		this.externalActionBuilders.set(
			externalActionId,
			builder as unknown as StoredExternalActionBuilder<TParams, TState>,
		);
		return this;
	}

	/** @internal */
	protected buildExternalActions():
		| Record<string, ProcessHumanTurnExternalActionSpec<TParams, TState>>
		| undefined {
		return this.externalActionBuilders.size > 0
			? buildSpecs(this.externalActionBuilders)
			: undefined;
	}
}

function buildSpecs<T>(builders: ReadonlyMap<string, { build(): T }>): Record<string, T> {
	return Object.fromEntries([...builders].map(([id, builder]) => [id, builder.build()]));
}

function assertLlmOutcomeParameters<TParams, TState>(
	turnId: TurnId,
	outcomes: Record<string, ProcessToolOutcomeSpec<TParams, TState>>,
): void {
	for (const [outcomeId, outcome] of Object.entries(outcomes)) {
		if (OUTCOME_TOOL_MARKDOWN_PARAMETER_NAME in outcome.parameters) {
			throw new Error(
				`LLM turn '${turnId}' outcome tool '${outcomeId}' cannot declare reserved markdown parameter '${OUTCOME_TOOL_MARKDOWN_PARAMETER_NAME}'`,
			);
		}
	}
}

/** LLM authoring families used to preserve fluent context and completion types. @public */
type LlmBuilderFamily =
	| {
			/** @public */
			kind: "ordinary";
	  }
	| {
			/** @public */
			kind: "mapped";
			/** @public */
			item: unknown;
			/** @public */
			result: unknown;
	  };

/** Active-item context supplied by an LLM authoring family. @public */
type LlmItemContext<TFamily extends LlmBuilderFamily> = TFamily extends {
	kind: "mapped";
	item: infer TItem;
}
	? MappedTurnItemContext<TItem>
	: Record<never, never>;

/** Preserve the concrete completion API when preparation or products refine its types. @public */
type ConfiguredLlmBuilder<
	TFamily extends LlmBuilderFamily,
	TParams,
	TState,
	TConsumedProducts extends string,
	TPrepared,
> = TFamily extends { kind: "mapped"; item: infer TItem; result: infer TResult }
	? MappedLlmFlowBuilder<TParams, TState, TItem, TResult, TConsumedProducts, TPrepared>
	: LlmFlowBuilder<TParams, TState, TConsumedProducts, TPrepared>;

/** @public */
abstract class LlmConfigurationBuilder<
	TParams,
	TState,
	TConsumedProducts extends string,
	TPrepared,
	TFamily extends LlmBuilderFamily,
> extends ExternalActionTurnBuilder<TParams, TState> {
	/** @internal */
	protected readonly turnKind = "LLM";
	private readonly configuration: Omit<
		LlmTurnDefinition<string, TParams, TState>,
		"kind" | "description" | "prompt" | "outcomes" | "turnEnd" | "forEach"
	> = { availableTools: [], branchType: "primary", context: "fresh", completionMode: "turn_end" };

	/** Wait on the server before this turn may allocate a worker. @public */
	waitFor(predicate: TurnWaitPredicate<TParams, TState>): this {
		if (this.configuration.waitFor)
			throw new Error(`Turn '${this.turnId}' already declares .waitFor(...)`);
		this.configuration.waitFor = predicate;
		return this;
	}
	private promptBuilder:
		| ((ctx: ProcessRuntimeTurnContext<TParams, TState>) => MaybePromise<string>)
		| null = null;
	private readonly consumedProductNames = new Set<string>();
	private readonly optionalConsumedProductNames = new Set<string>();

	/** @internal */
	protected abstract itemContext(
		ctx: ProcessRuntimeTurnContext<TParams, TState>,
	): LlmItemContext<TFamily>;

	/** @public */
	executionPurpose(purpose: string): this {
		if (purpose) this.configuration.executionPurpose = purpose;
		else delete this.configuration.executionPurpose;
		return this;
	}

	/** @internal */
	modelPurpose(purpose: LlmModelPurpose): this {
		this.configuration.modelPurpose = purpose;
		return this;
	}

	/** @public */
	tools(...tools: readonly PiBuiltInToolName[]): this {
		this.configuration.availableTools = tools;
		return this;
	}

	/** @public */
	integrationTools(...tools: readonly string[]): this {
		if (tools.length) this.configuration.integrationTools = tools.map((tool) => tool.trim());
		else delete this.configuration.integrationTools;
		return this;
	}

	/** @public */
	resolveIntegrationTools(resolver: (params: TParams, state: TState) => readonly string[]): this {
		this.configuration.resolveIntegrationTools = resolver;
		return this;
	}

	/** @public */
	prepare<TNextPrepared>(
		fn: (
			ctx: FlowLlmPreparationContext<TParams, TState> & LlmItemContext<TFamily>,
		) => MaybePromise<TNextPrepared>,
	): ConfiguredLlmBuilder<TFamily, TParams, TState, TConsumedProducts, TNextPrepared> {
		this.configuration.prepare = (ctx) =>
			fn({ ...createFlowAutomaticRunContext(ctx), ...this.itemContext(ctx) });
		return this.refineContext<TConsumedProducts, TNextPrepared>();
	}

	/** Enable durable operator questions for this LLM turn. @public */
	askQuestions(): this {
		this.configuration.askQuestions = true;
		return this;
	}

	/** @public */
	freshPrimary(): this {
		this.configuration.branchType = "primary";
		this.configuration.context = "fresh";
		delete this.configuration.startFrom;
		delete this.configuration.restorePrimaryLeafAfterTurn;
		return this;
	}

	/** @internal */
	freshSeededPrimary(): this {
		this.configuration.branchType = "primary";
		this.configuration.context = "fresh_seeded";
		delete this.configuration.startFrom;
		delete this.configuration.restorePrimaryLeafAfterTurn;
		return this;
	}

	/** @public */
	fullPrimary(): this {
		this.configuration.branchType = "primary";
		this.configuration.context = "full";
		return this;
	}

	/** @internal */
	rootBranchReview(): this {
		this.configuration.branchType = "root_branch";
		this.configuration.context = "full";
		this.configuration.restorePrimaryLeafAfterTurn = true;
		return this;
	}

	/** @public */
	continueFromPrimaryLeaf(): this {
		this.configuration.startFrom = {
			kind: "semantic_ref",
			ref: "currentPrimaryPathLeaf",
			fallback: { kind: "current_leaf" },
		};
		return this;
	}

	/** @internal */
	continueFromReviewBranch(): this {
		this.configuration.startFrom = {
			kind: "semantic_ref",
			ref: "review",
			fallback: { kind: "current_leaf" },
		};
		return this;
	}

	/** @internal */
	continueFromProductBranch(
		productName: string,
		fallback: ProcessTurnStartSelection = { kind: "current_leaf" },
	): this {
		return this.startFromProductBranch(productName, fallback);
	}

	/** @internal */
	startFromReviewBranch(): this {
		this.configuration.startFrom = {
			kind: "semantic_ref",
			ref: "review",
			fallback: { kind: "session_root" },
		};
		return this;
	}

	/** @internal */
	startFromProductBranch(
		productName: string,
		fallback: ProcessTurnStartSelection = { kind: "session_root" },
	): this {
		this.configuration.startFrom = {
			kind: "product_ref",
			productName: normalizeProductName(productName),
			fallback,
		};
		return this;
	}

	/** @internal */
	startFromRoot(): this {
		this.configuration.startFrom = { kind: "session_root" };
		return this;
	}

	/** @public */
	consume<TProductName extends string>(
		productName: TProductName,
	): ConfiguredLlmBuilder<TFamily, TParams, TState, TConsumedProducts | TProductName, TPrepared> {
		this.consumedProductNames.add(normalizeProductName(productName));
		return this.refineContext<TConsumedProducts | TProductName, TPrepared>();
	}

	/** @public */
	optionalConsume<TProductName extends string>(
		productName: TProductName,
	): ConfiguredLlmBuilder<TFamily, TParams, TState, TConsumedProducts | TProductName, TPrepared> {
		this.optionalConsumedProductNames.add(normalizeProductName(productName));
		return this.refineContext<TConsumedProducts | TProductName, TPrepared>();
	}

	private refineContext<
		TNextConsumedProducts extends string,
		TNextPrepared,
	>(): ConfiguredLlmBuilder<TFamily, TParams, TState, TNextConsumedProducts, TNextPrepared> {
		// Fluent configuration mutates this builder; only its context type changes.
		return this as unknown as ConfiguredLlmBuilder<
			TFamily,
			TParams,
			TState,
			TNextConsumedProducts,
			TNextPrepared
		>;
	}

	/** @public */
	buildPrompt(
		fn: (
			ctx: FlowPromptContext<TParams, TState, TConsumedProducts, TPrepared> &
				LlmItemContext<TFamily>,
		) => MaybePromise<string>,
	): this {
		this.promptBuilder = (ctx) =>
			fn({
				...createFlowPromptContext<TParams, TState, TConsumedProducts, TPrepared>(
					ctx,
					[...this.consumedProductNames] as TConsumedProducts[],
					[...this.optionalConsumedProductNames],
				),
				...this.itemContext(ctx),
			});
		return this;
	}

	/** @public */
	prompt(
		prompt: string | ((ctx: ProcessRuntimeTurnContext<TParams, TState>) => MaybePromise<string>),
	): this {
		this.promptBuilder = typeof prompt === "string" ? () => prompt : prompt;
		return this;
	}

	/** @internal */
	protected buildBaseDefinition(): Omit<
		LlmTurnDefinition<string, TParams, TState>,
		"outcomes" | "turnEnd" | "forEach"
	> {
		if (!this.turnDescription) {
			throw new Error(`LLM turn '${this.turnId}' must declare .description(...)`);
		}
		const prompt = this.promptBuilder;
		if (!prompt) {
			throw new Error(`LLM turn '${this.turnId}' must declare .buildPrompt(...)`);
		}
		const externalActions = this.buildExternalActions();
		return {
			...this.configuration,
			...(externalActions ? { externalActions } : {}),
			kind: "llm",
			description: this.turnDescription,
			prompt,
			...(this.consumedProductNames.size > 0
				? { consumedProducts: [...this.consumedProductNames] }
				: {}),
			...(this.optionalConsumedProductNames.size > 0
				? { optionalConsumedProducts: [...this.optionalConsumedProductNames] }
				: {}),
		};
	}
}

/** @public */
export class LlmFlowBuilder<
		TParams = unknown,
		TState = unknown,
		TConsumedProducts extends string = never,
		TPrepared = undefined,
	>
	extends LlmConfigurationBuilder<
		TParams,
		TState,
		TConsumedProducts,
		TPrepared,
		{ kind: "ordinary" }
	>
	implements FlowLlmTurn<TParams, TState, string>
{
	private publishedResult: {
		productName: string;
		builder: PublishedResultBuilder<TParams, TState>;
	} | null = null;
	private endResult: LlmTurnEndBuilder<TParams, TState> | null = null;
	private outcomeToolBuilders = new Map<string, OutcomeToolBuilder<TParams, TState>>();

	/** @internal */
	protected itemContext(): Record<never, never> {
		return {};
	}

	/** @public */
	publish(productName: string): PublishedResultBuilder<TParams, TState> {
		const normalized = normalizeProductName(productName);
		if (this.publishedResult) {
			throw new Error(`LLM turn '${this.turnId}' can publish only one product in flow v1`);
		}
		if (this.endResult) {
			throw new Error(`LLM turn '${this.turnId}' cannot declare both .publish(...) and .end(...)`);
		}
		const builder = new PublishedResultBuilder<TParams, TState>(normalized, this);
		this.publishedResult = { productName: normalized, builder };
		return builder;
	}

	/** @public */
	end(outcomeId: string): LlmTurnEndBuilder<TParams, TState> {
		if (this.endResult) {
			throw new Error(`LLM turn '${this.turnId}' declares duplicate .end(...) completion`);
		}
		if (this.publishedResult) {
			throw new Error(`LLM turn '${this.turnId}' cannot declare both .publish(...) and .end(...)`);
		}
		if (this.outcomeToolBuilders.size > 0) {
			throw new Error(`LLM turn '${this.turnId}' cannot declare both .end(...) and outcome tools`);
		}
		this.endResult = new LlmTurnEndBuilder<TParams, TState>(outcomeId, this);
		return this.endResult;
	}

	/** @public */
	outcomeTool(
		id: string,
		configure: (
			tool: OutcomeToolBuilder<TParams, TState>,
		) => OutcomeToolBuilder<TParams, TState> | undefined,
	): this {
		if (id.trim() === "") {
			throw new Error(`LLM turn '${this.turnId}' declares an empty outcome tool id`);
		}
		if (this.endResult) {
			throw new Error(`LLM turn '${this.turnId}' cannot declare both .end(...) and outcome tools`);
		}
		if (this.publishedResult) {
			throw new Error(`LLM turn '${this.turnId}' cannot declare outcome tools after .publish(...)`);
		}
		if (this.outcomeToolBuilders.has(id)) {
			throw new Error(`LLM turn '${this.turnId}' declares duplicate outcome tool '${id}'`);
		}
		const builder = new OutcomeToolBuilder<TParams, TState>();
		configure(builder);
		this.outcomeToolBuilders.set(id, builder);
		return this;
	}

	/** @internal */
	producesPlan(
		configure: (plan: PlanResultBuilder<TParams, TState>) => PlanResultBuilder<TParams, TState>,
	): FlowLlmTurn<TParams, TState, typeof DEFAULT_PLAN_RESULT_OUTCOME_ID> {
		const definition = this.buildBaseDefinition();
		const plan = configure(new PlanResultBuilder<TParams, TState>());
		const outcome = plan.buildOutcome();
		return {
			id: this.turnId,
			definition: {
				...definition,
				outcomes: {
					[DEFAULT_PLAN_RESULT_OUTCOME_ID]: outcome,
				},
				turnResultMarkdown: OUTCOME_TOOL_ARGUMENT_TURN_RESULT,
				resultSemanticRef: "plan",
				publishedProduct: "plan",
			},
		};
	}

	/** @internal */
	get definition(): LlmTurnDefinition<string, TParams, TState> {
		const definition = this.buildBaseDefinition();
		const explicitTurnEnd = this.endResult;
		const published = this.publishedResult;
		const outcomes = buildSpecs(this.outcomeToolBuilders);
		const hasOutcomeTools = Object.keys(outcomes).length > 0;
		const outcomePublishedProducts = new Set(
			Object.values(outcomes)
				.map((outcome) => outcome.publishedProduct)
				.filter((productName): productName is string => typeof productName === "string"),
		);
		const hasOutcomePublishedProduct = outcomePublishedProducts.size > 0;
		let turnEnd = explicitTurnEnd?.build();
		let resultSemanticRef: "plan" | "review" | undefined = outcomePublishedProducts.has("review")
			? "review"
			: outcomePublishedProducts.has("plan")
				? "plan"
				: undefined;
		let turnResultMarkdown: LlmTurnDefinition<string, TParams, TState>["turnResultMarkdown"];
		let publishedProduct: string | undefined;

		if (published) {
			publishedProduct = published.productName;
			if (published.productName === "plan" || published.productName === "review") {
				resultSemanticRef = published.productName;
			}
			const publishHasRoute = published.builder.hasRoute();
			if (publishHasRoute === hasOutcomeTools) {
				throw new Error(
					hasOutcomeTools
						? `LLM turn '${this.turnId}' cannot route published product '${published.productName}' and declare outcome tools in flow v1`
						: `LLM turn '${this.turnId}' publishes product '${published.productName}' but declares no route or outcome tool completion path`,
				);
			}
			turnResultMarkdown = publishHasRoute
				? ASSISTANT_OUTPUT_TURN_RESULT
				: OUTCOME_TOOL_ARGUMENT_TURN_RESULT;
			if (publishHasRoute) turnEnd = published.builder.buildTurnEnd();
		} else if (hasOutcomeTools && !hasOutcomePublishedProduct) {
			turnResultMarkdown = OUTCOME_TOOL_ARGUMENT_TURN_RESULT;
		} else if (explicitTurnEnd) {
			turnResultMarkdown = ASSISTANT_OUTPUT_TURN_RESULT;
		}

		assertLlmOutcomeParameters(this.turnId, outcomes);

		if (explicitTurnEnd && hasOutcomeTools) {
			throw new Error(`LLM turn '${this.turnId}' cannot declare multiple completion paths`);
		}
		if (!hasOutcomeTools && !turnEnd) {
			throw new Error(`LLM turn '${this.turnId}' must declare a completion path`);
		}

		return {
			...definition,
			...(hasOutcomeTools ? { outcomes } : {}),
			...(turnEnd ? { turnEnd } : {}),
			...(turnResultMarkdown ? { turnResultMarkdown } : {}),
			...(resultSemanticRef ? { resultSemanticRef } : {}),
			...(publishedProduct ? { publishedProduct } : {}),
		};
	}
}

/** Item selection for `flow.mappedLlm(...)`. @public */
export type FlowForEachOptions<TParams, TState, TItem, TResult> = Pick<
	MappedLlmTurnSpec<TParams, TState, TItem, TResult>,
	"items" | "itemCodec" | "resultCodec" | "key" | "label" | "stateAfterSnapshot"
>;

/** @public */
export type FlowMappedPromptContext<
	TParams,
	TState,
	TItem,
	TConsumedProducts extends string,
	TPrepared,
> = FlowPromptContext<TParams, TState, TConsumedProducts, TPrepared> & MappedTurnItemContext<TItem>;

/** @public */
export type FlowMappedPreparationContext<TParams, TState, TItem> = FlowLlmPreparationContext<
	TParams,
	TState
> &
	MappedTurnItemContext<TItem>;

/**
 * Outcome of one mapped item. It declares parameters and yields the item's
 * result; it cannot route, change process state, or publish products.
 * @public
 */
export class MappedOutcomeBuilder<
	TParams = unknown,
	TState = unknown,
	TItem = unknown,
	TResult = unknown,
> extends OutcomeParametersBuilder {
	private yieldResult: MappedItemYield<TParams, TState, TItem, TResult> | null = null;

	/** Map this outcome to the item's typed result. @public */
	yield(fn: MappedItemYield<TParams, TState, TItem, TResult>): this {
		this.yieldResult = fn;
		return this;
	}

	/** @internal */
	build(): {
		/** @internal */
		tool: ProcessToolOutcomeSpec<TParams, TState>;
		/** @internal */
		yieldResult: MappedItemYield<TParams, TState, TItem, TResult>;
	} {
		if (!this.yieldResult) {
			throw new Error("Mapped outcome must declare .yield(...)");
		}
		return { tool: this.buildParameterSpec("Mapped outcome tool"), yieldResult: this.yieldResult };
	}
}

/** Routes a mapped turn once, after all item results are collected. @public */
export class MappedCollectBuilder<TParams = unknown, TState = unknown>
	implements FlowLlmTurn<TParams, TState, string>
{
	/** @internal */
	constructor(
		private readonly turn: FlowLlmTurn<TParams, TState, string>,
		private readonly setRouting: (routing: MappedCollectRouting<TParams, TState>) => void,
	) {}

	/** @internal */
	get id(): TurnId {
		return this.turn.id;
	}

	/** @internal */
	get definition(): LlmTurnDefinition<string, TParams, TState> {
		return this.turn.definition;
	}

	/** @public */
	to(turnId: TurnId): this {
		this.setRouting({ kind: "static", to: turnId });
		return this;
	}

	/** @public */
	complete(): this {
		this.setRouting({ kind: "static", lifecycleStatus: "completed" });
		return this;
	}

	/** @public */
	lifecycleStatus(status: ProcessTurnTerminalLifecycleStatus): this {
		this.setRouting({ kind: "static", lifecycleStatus: status });
		return this;
	}

	/** Choose the next turn from the collected state. @public */
	routeByState(
		branches: Record<string, TurnId>,
		choose: (ctx: MappedTurnServerContext<TParams, TState>) => MaybePromise<string>,
	): this {
		if (Object.keys(branches).length === 0) {
			throw new Error("Mapped collection routing must declare at least one branch");
		}
		this.setRouting({ kind: "branches", branches: { ...branches }, choose });
		return this;
	}
}

/**
 * LLM turn that runs once per frozen item. Business state and routing belong
 * to `.collect(...)`.
 * @public
 */
export class MappedLlmFlowBuilder<
		TParams = unknown,
		TState = unknown,
		TItem = unknown,
		TResult = unknown,
		TConsumedProducts extends string = never,
		TPrepared = undefined,
	>
	extends LlmConfigurationBuilder<
		TParams,
		TState,
		TConsumedProducts,
		TPrepared,
		{ kind: "mapped"; item: TItem; result: TResult }
	>
	implements FlowLlmTurn<TParams, TState, string>
{
	private readonly outcomes = new Map<
		string,
		MappedOutcomeBuilder<TParams, TState, TItem, TResult>
	>();
	private collection: MappedCollect<TParams, TState, TResult> | undefined;
	private routing: MappedCollectRouting<TParams, TState> | undefined;

	/** @internal */
	constructor(
		turnId: TurnId,
		private readonly items: FlowForEachOptions<TParams, TState, TItem, TResult>,
	) {
		super(turnId);
	}

	/** @internal */
	protected itemContext(
		ctx: ProcessRuntimeTurnContext<TParams, TState>,
	): MappedTurnItemContext<TItem> {
		const iteration = ctx.iteration;
		if (!iteration) {
			throw new Error(`Mapped turn '${this.turnId}' requires an active item`);
		}
		return {
			item: this.items.itemCodec.parse(iteration.item),
			itemKey: iteration.itemKey,
			itemLabel: iteration.itemLabel,
			itemIndex: iteration.itemIndex,
			itemCount: iteration.itemCount,
		};
	}

	/** @public */
	outcomeTool(
		id: string,
		configure: (
			outcome: MappedOutcomeBuilder<TParams, TState, TItem, TResult>,
		) => MappedOutcomeBuilder<TParams, TState, TItem, TResult> | undefined,
	): this {
		if (id.trim() === "") {
			throw new Error(`LLM turn '${this.turnId}' declares an empty outcome tool id`);
		}
		if (this.outcomes.has(id)) {
			throw new Error(`LLM turn '${this.turnId}' declares duplicate outcome tool '${id}'`);
		}
		const outcome = new MappedOutcomeBuilder<TParams, TState, TItem, TResult>();
		configure(outcome);
		outcome.build();
		this.outcomes.set(id, outcome);
		return this;
	}

	/** Combine ordered item results into process state, once. @public */
	collect(fn: MappedCollect<TParams, TState, TResult>): MappedCollectBuilder<TParams, TState> {
		if (this.collection) {
			throw new Error(`Mapped turn '${this.turnId}' declares .collect(...) more than once`);
		}
		this.collection = fn;
		return new MappedCollectBuilder(this, (routing) => {
			if (this.routing) {
				throw new Error(`Mapped turn '${this.turnId}' collection already declares a route`);
			}
			this.routing = routing;
		});
	}

	/** @internal */
	get definition(): LlmTurnDefinition<string, TParams, TState> {
		const definition = this.buildBaseDefinition();
		if (this.outcomes.size === 0) {
			throw new Error(`Mapped turn '${this.turnId}' must declare an item outcome tool`);
		}
		if (!this.collection) {
			throw new Error(`Mapped turn '${this.turnId}' must declare .collect(...)`);
		}
		if (!this.routing) {
			throw new Error(`Mapped turn '${this.turnId}' must declare a collection route`);
		}
		const outcomes: Record<string, ProcessToolOutcomeSpec<TParams, TState>> = {};
		const yields: Record<string, MappedItemYield<TParams, TState, TItem, TResult>> = {};
		for (const [id, builder] of this.outcomes) {
			const built = builder.build();
			outcomes[id] = built.tool;
			yields[id] = built.yieldResult;
		}
		assertLlmOutcomeParameters(this.turnId, outcomes);
		const forEach: MappedLlmTurnSpec<TParams, TState, TItem, TResult> = {
			...this.items,
			yields,
			collect: this.collection,
			routing: this.routing,
		};
		return {
			...definition,
			outcomes,
			turnResultMarkdown: OUTCOME_TOOL_ARGUMENT_TURN_RESULT,
			// The codecs preserve item/result types across the erased runtime definition boundary.
			forEach: forEach as MappedLlmTurnSpec<TParams, TState>,
		};
	}
}

/** @public */
export class AutomaticFlowBuilder<TParams = unknown, TState = unknown>
	extends ExternalActionTurnBuilder<TParams, TState>
	implements FlowAutomaticTurn<TParams, TState, string>
{
	/** @internal */
	protected readonly turnKind = "Automatic";
	private runFn:
		| ((ctx: FlowAutomaticRunContext<TParams, TState>) => MaybePromise<WorkerCompleteInput<string>>)
		| null = null;
	private outcomeBuilders = new Map<string, AutomaticOutcomeBuilder<TParams, TState>>();
	private availableIntegrationTools: readonly string[] = [];
	private waitPredicate: TurnWaitPredicate<TParams, TState> | undefined;
	/** Wait on the server before this turn may allocate a worker. @public */
	waitFor(predicate: TurnWaitPredicate<TParams, TState>): this {
		if (this.waitPredicate) throw new Error(`Turn '${this.turnId}' already declares .waitFor(...)`);
		this.waitPredicate = predicate;
		return this;
	}

	/** @public */
	run(
		fn: (
			ctx: FlowAutomaticRunContext<TParams, TState>,
		) => MaybePromise<WorkerCompleteInput<string>>,
	): this {
		this.runFn = fn;
		return this;
	}

	/** @public */
	integrationTools(...tools: readonly string[]): this {
		this.availableIntegrationTools = tools.map((tool) => tool.trim());
		return this;
	}

	/** @public */
	outcome(
		id: string,
		configure: (
			outcome: AutomaticOutcomeBuilder<TParams, TState>,
		) => AutomaticOutcomeBuilder<TParams, TState> | undefined,
	): this {
		if (id.trim() === "") {
			throw new Error(`Automatic turn '${this.turnId}' declares an empty outcome id`);
		}
		if (this.outcomeBuilders.has(id)) {
			throw new Error(`Automatic turn '${this.turnId}' declares duplicate outcome '${id}'`);
		}
		const builder = new AutomaticOutcomeBuilder<TParams, TState>();
		configure(builder);
		this.outcomeBuilders.set(id, builder);
		return this;
	}

	/** @internal */
	get definition(): AutomaticTurnDefinition<string, TParams, TState> {
		if (!this.turnDescription) {
			throw new Error(`Automatic turn '${this.turnId}' must declare .description(...)`);
		}
		if (!this.runFn) {
			throw new Error(`Automatic turn '${this.turnId}' must declare .run(...)`);
		}
		if (this.outcomeBuilders.size === 0) {
			throw new Error(`Automatic turn '${this.turnId}' must declare at least one outcome`);
		}
		const outcomes = buildSpecs(this.outcomeBuilders);
		const runFn = this.runFn;
		const externalActions = this.buildExternalActions();
		return {
			kind: "automatic",
			description: this.turnDescription,
			...(this.waitPredicate ? { waitFor: this.waitPredicate } : {}),
			...(this.availableIntegrationTools.length > 0
				? { integrationTools: this.availableIntegrationTools }
				: {}),
			...(externalActions ? { externalActions } : {}),
			outcomes,
			run: (ctx) => runFn(createFlowAutomaticRunContext(ctx)),
		};
	}
}

function inferAcceptanceState(actionId: string): ProcessHumanTurnActionSpec["acceptanceState"] {
	const normalized = actionId.toLowerCase();
	if (/approve|accept|complete|merged/.test(normalized)) {
		return "accepted";
	}
	if (/request|revision|feedback|change|reject/.test(normalized)) {
		return "requires_changes";
	}
	return "neutral";
}

/** @public */
export class HumanActionBuilder<TParams = unknown, TState = unknown> {
	private spec: Record<string, unknown> = {};

	/** @internal */
	constructor(private readonly actionId: string) {}

	/** @public */
	label(label: string): this {
		this.spec.label = label;
		return this;
	}

	/** @internal */
	description(description: string): this {
		this.spec.description = description;
		return this;
	}

	/** @public */
	acceptanceState(state: ProcessHumanTurnActionSpec<TParams, TState>["acceptanceState"]): this {
		this.spec.acceptanceState = state;
		return this;
	}

	/** @public */
	form(form: FormDefinition): this {
		this.spec.form = form;
		return this;
	}

	/** @public */
	to(turnId: TurnId): this {
		this.spec.to = turnId;
		return this;
	}

	/** @internal */
	complete(): this {
		this.spec.complete = true;
		return this;
	}

	/** @public */
	lifecycleStatus(status: ProcessTurnTerminalLifecycleStatus): this {
		this.spec.lifecycleStatus = status;
		return this;
	}

	/** @internal */
	trigger(trigger: string): this {
		this.spec.trigger = trigger;
		return this;
	}

	/** @internal */
	schedulable(value = true): this {
		this.spec.schedulable = value;
		return this;
	}

	/** @public */
	effect(effect: ProcessHumanTurnActionSpec<TParams, TState>["effect"]): this {
		this.spec.effect = effect;
		return this;
	}

	/** @internal */
	build(): ProcessHumanTurnActionSpec<TParams, TState> {
		return {
			label:
				typeof this.spec.label === "string" ? this.spec.label : humanizeProcessLabel(this.actionId),
			acceptanceState:
				(this.spec.acceptanceState as
					| ProcessHumanTurnActionSpec<TParams, TState>["acceptanceState"]
					| undefined) ?? inferAcceptanceState(this.actionId),
			...this.spec,
		} as ProcessHumanTurnActionSpec<TParams, TState>;
	}
}

/** @public */
export class ExternalActionBuilder<
	TParams = unknown,
	TState = unknown,
	TEvent = unknown,
	TInput extends Record<string, unknown> = Record<string, unknown>,
> {
	private spec: Partial<ProcessHumanTurnExternalActionSpec<TParams, TState, TEvent, TInput>>;

	/** @internal */
	constructor(actionId: string, source: ExternalActionSource<TParams, TState, TEvent, TInput>) {
		this.spec = { id: actionId, source };
	}

	/** @public */
	label(label: string): this {
		this.spec.label = label;
		return this;
	}

	/** @public */
	description(description: string): this {
		this.spec.description = description;
		return this;
	}

	/** @public */
	when(condition: NonNullable<ProcessHumanTurnExternalActionSpec<TParams, TState>["when"]>): this {
		this.spec.when = condition;
		return this;
	}

	/** @public */
	to(turnId: TurnId): this {
		this.spec.to = turnId;
		return this;
	}

	/** @internal */
	complete(): this {
		this.spec.complete = true;
		return this;
	}

	/** @public */
	lifecycleStatus(status: ProcessTurnTerminalLifecycleStatus): this {
		this.spec.lifecycleStatus = status;
		return this;
	}

	/** @internal */
	publishInput(
		productName: string,
		options: {
			/** @internal */
			inputField: string;
		},
	): this {
		this.spec.publishInput = {
			productName: normalizeProductName(productName),
			inputField: options.inputField,
		};
		return this;
	}

	/** @public */
	effect(effect: ExternalSourceEffect<TParams, TState, TEvent, TInput>): this {
		this.spec.effect = effect;
		return this;
	}

	/** @internal */
	build(): ProcessHumanTurnExternalActionSpec<TParams, TState, TEvent, TInput> {
		return this.spec as ProcessHumanTurnExternalActionSpec<TParams, TState, TEvent, TInput>;
	}
}

/** @public */
export class HumanFlowBuilder<TParams = unknown, TState = unknown>
	extends ExternalActionTurnBuilder<TParams, TState>
	implements FlowHumanTurn<TParams, TState>
{
	/** @internal */
	protected readonly turnKind = "Human";
	private readonly metadata: Omit<
		HumanTurnDefinition<TParams, TState>,
		"kind" | "description" | "actions" | "externalActions"
	> = {};
	private actions = new Map<string, HumanActionBuilder<TParams, TState>>();

	/** @public */
	get definition(): HumanTurnDefinition<TParams, TState> {
		if (!this.turnDescription) {
			throw new Error(`Human turn '${this.turnId}' must declare .description(...)`);
		}
		const externalActions = this.buildExternalActions();
		return {
			kind: "human",
			description: this.turnDescription,
			...this.metadata,
			actions: buildSpecs(this.actions),
			...(externalActions ? { externalActions } : {}),
		};
	}

	/** @public */
	reviewProduct(productName: string): this {
		this.metadata.reviewProduct = normalizeProductName(productName);
		if (productName === "plan" || productName === "review")
			this.metadata.reviewSemanticRef = productName;
		else delete this.metadata.reviewSemanticRef;
		return this;
	}

	/** @public */
	operatorAttention(attention: HumanTurnOperatorAttention): this {
		this.metadata.operatorAttention = attention;
		return this;
	}

	/** @internal */
	commentary(commentary: string): this {
		if (commentary) this.metadata.commentary = commentary;
		else delete this.metadata.commentary;
		return this;
	}

	/** @internal */
	notesFields(notes: HumanTurnDefinition<TParams, TState>["notesFields"]): this {
		if (notes) this.metadata.notesFields = notes;
		else delete this.metadata.notesFields;
		return this;
	}

	/** @public */
	action(
		actionId: string,
		configure: (
			action: HumanActionBuilder<TParams, TState>,
		) => HumanActionBuilder<TParams, TState> | undefined,
	): this {
		if (this.actions.has(actionId)) {
			throw new Error(`Human turn '${this.turnId}' declares duplicate action '${actionId}'`);
		}
		const builder = new HumanActionBuilder<TParams, TState>(actionId);
		configure(builder);
		this.actions.set(actionId, builder);
		return this;
	}
}

/** @public */
export class ExternalRouteBuilder<
	TParams = unknown,
	TState = unknown,
	TEvent = unknown,
	TInput extends Record<string, unknown> = Record<string, unknown>,
> implements FlowExternalTurn<TParams, TState>
{
	private externalEffect: ExternalSourceEffect<TParams, TState, TEvent, TInput> | undefined;
	private target: FlowTargetSpec = null;
	/** @internal */
	constructor(
		private readonly parent: ExternalFlowBuilder<TParams, TState>,
		private readonly source: ExternalActionSource<TParams, TState, TEvent, TInput>,
	) {}

	/** @internal */
	get id(): TurnId {
		return this.parent.id;
	}

	/** @internal */
	get definition(): ExternalTurnDefinition<TParams, TState> {
		return this.parent.definition;
	}

	private setTarget(next: Exclude<FlowTargetSpec, null>): this {
		if (this.target) {
			throw new Error("External source route already declares a target");
		}
		this.target = next;
		return this;
	}

	/** @public */
	to(turnId: TurnId): this {
		return this.setTarget({ to: turnId });
	}

	/** @internal */
	complete(): this {
		return this.setTarget({ complete: true });
	}

	/** @internal */
	lifecycleStatus(status: ProcessTurnTerminalLifecycleStatus): this {
		return this.setTarget({ lifecycleStatus: status });
	}

	/** @internal */
	state(
		fn: (input: {
			/** @internal */
			ctx: FlowExternalSourceContext<TParams, TState, TEvent, TInput>;
			/** @internal */
			event: TEvent;
			/** @internal */
			input: TInput;
		}) => MaybePromise<TState>,
	): this {
		this.externalEffect = async (ctx) => ({
			state: await fn({ ctx, event: ctx.event, input: ctx.input }),
		});
		return this;
	}

	/** @internal */
	effect(
		fn: (input: {
			/** @internal */
			ctx: FlowExternalSourceContext<TParams, TState, TEvent, TInput>;
			/** @internal */
			event: TEvent;
			/** @internal */
			input: TInput;
		}) => MaybePromise<ProcessEffectPlan<TState> | undefined>,
	): this {
		this.externalEffect = (ctx) => fn({ ctx, event: ctx.event, input: ctx.input });
		return this;
	}

	/** @internal */
	build() {
		return {
			/** @internal */
			source: this.source,
			...this.target,
			...(this.externalEffect
				? {
						/** @internal */
						effect: this.externalEffect,
					}
				: {}),
		};
	}
}

/** @public */
export class ExternalFlowBuilder<TParams = unknown, TState = unknown>
	extends DescribedTurnBuilder
	implements FlowExternalTurn<TParams, TState>
{
	private routeBuilders: ExternalRouteBuilder<TParams, TState, unknown, Record<string, unknown>>[] =
		[];

	/** @internal */
	get definition(): ExternalTurnDefinition<TParams, TState> {
		if (!this.turnDescription) {
			this.turnDescription =
				this.routeBuilders[0]?.build().source.description ?? "Wait for an external source";
		}
		if (this.routeBuilders.length === 0) {
			throw new Error(`External turn '${this.turnId}' must declare at least one .from(...) source`);
		}
		return {
			kind: "external",
			description: this.turnDescription,
			transitions: this.routeBuilders.map((builder) => builder.build()),
		};
	}

	/** @public */
	from<TEvent = unknown, TInput extends Record<string, unknown> = Record<string, unknown>>(
		source: ExternalActionSource<TParams, TState, TEvent, TInput>,
	): ExternalRouteBuilder<TParams, TState, TEvent, TInput> {
		const builder = new ExternalRouteBuilder<TParams, TState, TEvent, TInput>(this, source);
		this.routeBuilders.push(
			builder as unknown as ExternalRouteBuilder<TParams, TState, unknown, Record<string, unknown>>,
		);
		return builder;
	}
}

/** @public */
type Hook<TApi> = (api: TApi) => void;

function chainHooks<TApi>(hooks: readonly Hook<TApi>[]): Hook<TApi> {
	return (api) => {
		for (const hook of hooks) hook(api);
	};
}

/** @public */
export abstract class FlowComponentBuilder<TParams = unknown, TState = unknown> {
	/** @internal */
	readonly turns: FlowTurn<TParams, TState>[] = [];
	/** @internal */
	readonly serverHooks: Hook<ServerProcessAPI<TParams, TState>>[] = [];
	/** @internal */
	readonly uiHooks: Hook<UiProcessAPI<TParams, TState>>[] = [];
	/** @internal */
	readonly launcherHooks: Hook<ProcessLauncherAPI<TParams>>[] = [];
	/** @internal */
	readonly watcherHooks: Hook<ProcessWatcherAPI<TParams>>[] = [];

	/** @public */
	turn(turn: FlowTurn<TParams, TState>): this {
		this.turns.push(turn);
		return this;
	}

	/** @internal */
	server(hook: Hook<ServerProcessAPI<TParams, TState>>): this {
		this.serverHooks.push(hook);
		return this;
	}

	/** @internal */
	action(definition: ProcessActionDefinition<TParams, TState>): this {
		this.serverHooks.push((api) => api.action(definition));
		return this;
	}

	/** @internal */
	ui(hook: Hook<UiProcessAPI<TParams, TState>>): this {
		this.uiHooks.push(hook);
		return this;
	}

	/** @public */
	launcher(
		definitionOrHook: ProcessLauncherDefinition<TParams> | Hook<ProcessLauncherAPI<TParams>>,
	): this {
		if (typeof definitionOrHook === "function") {
			this.launcherHooks.push(definitionOrHook);
		} else {
			this.launcherHooks.push((api) => api.launcher(definitionOrHook));
		}
		return this;
	}

	/** @public */
	watcher<TEvent = unknown, TConfig = unknown>(
		definitionOrHook:
			| ProcessWatcherDefinition<TParams, TEvent, TConfig>
			| Hook<ProcessWatcherAPI<TParams>>,
	): this {
		if (typeof definitionOrHook === "function") {
			this.watcherHooks.push(definitionOrHook);
		} else {
			this.watcherHooks.push((api) => api.watcher(definitionOrHook));
		}
		return this;
	}
}

/** @public */
export class FlowFragmentBuilder<TParams = unknown, TState = unknown> extends FlowComponentBuilder<
	TParams,
	TState
> {
	/** @internal */
	readonly name: string;

	/** @internal */
	constructor(name: string) {
		super();
		if (name.trim() === "") {
			throw new Error("Flow fragment name must be non-empty");
		}
		this.name = name;
	}
}

/** @public */
export class FlowProcessBuilder<TParams = unknown, TState = unknown> extends FlowComponentBuilder<
	TParams,
	TState
> {
	private readonly processId: string;
	private readonly configuration: Partial<DefinedProcessInput<TParams, TState>> = {};
	private readonly alternateEntryTurnIds: TurnId[] = [];

	/** @internal */
	constructor(processId: string) {
		super();
		if (processId.trim() === "") {
			throw new Error("Flow process id must be non-empty");
		}
		this.processId = processId;
	}

	/** @public */
	displayName(displayName: string): this {
		this.configuration.displayName = displayName;
		return this;
	}

	/** @public */
	entry(turnId: TurnId): this {
		this.configuration.entry = turnId;
		return this;
	}

	/** Declare an additional turn that launchers may select as the first turn. @internal */
	alternateEntry(turnId: TurnId): this {
		this.alternateEntryTurnIds.push(turnId);
		return this;
	}

	/**
	 * Declare the happy path: the ordered spine of turns a successful run walks
	 * through. Flow diagrams render this as the main line. Must start at the entry
	 * turn and reference only declared turns without repeats.
	 */
	/** @public */
	happyPath(...turnIds: readonly TurnId[]): this {
		this.configuration.happyPath = turnIds;
		return this;
	}

	/** @public */
	codecs(input: {
		/** @public */
		params: Codec<TParams>;
		/** @public */
		state: Codec<TState>;
	}): this {
		this.configuration.paramsCodec = input.params;
		this.configuration.stateCodec = input.state;
		return this;
	}

	/** @public */
	initialState(fn: (params: TParams) => TState): this {
		this.configuration.initialState = fn;
		return this;
	}

	/** @public */
	repositoryCredentials(
		fn: NonNullable<ExtensionProcessDefinition<TParams, TState>["repositoryCredentials"]>,
	): this {
		this.configuration.repositoryCredentials = fn;
		return this;
	}

	/** Resolve new process-volume capacity on the server; operator configuration wins. @internal */
	resolveStorageSize(
		fn: NonNullable<ExtensionProcessDefinition<TParams, TState>["resolveStorageSize"]>,
	): this {
		this.configuration.resolveStorageSize = fn;
		return this;
	}

	/** @public */
	piConfig(config: ProcessPiConfig): this {
		this.configuration.piConfig = config;
		return this;
	}

	/** Declare runner-provided process runtime capabilities. @public */
	runtime(capabilities: {
		/** @internal */
		developmentTools?: boolean;
		/** @public */
		docker?: boolean;
		/** @internal */
		repositoryCheckout?: "eager" | "on_demand" | "none";
	}): this {
		const runtime = {
			...(capabilities.developmentTools === true ? { developmentTools: true } : {}),
			...(capabilities.docker === true ? { docker: true } : {}),
			...(capabilities.repositoryCheckout
				? { repositoryCheckout: capabilities.repositoryCheckout }
				: {}),
		};
		if (Object.keys(runtime).length) this.configuration.runtime = runtime;
		else delete this.configuration.runtime;
		return this;
	}

	/** @internal */
	use(fragment: FlowFragmentBuilder<TParams, TState>): this {
		this.turns.push(...fragment.turns);
		this.serverHooks.push(...fragment.serverHooks);
		this.uiHooks.push(...fragment.uiHooks);
		this.launcherHooks.push(...fragment.launcherHooks);
		this.watcherHooks.push(...fragment.watcherHooks);
		return this;
	}

	/** @public */
	define(): ExtensionProcessDefinition<TParams, TState> {
		const { displayName, entry, paramsCodec, stateCodec, initialState } = this.configuration;
		if (!displayName) {
			throw new Error(`Flow process '${this.processId}' must declare .displayName(...)`);
		}
		if (!entry) {
			throw new Error(`Flow process '${this.processId}' must declare .entry(turnId)`);
		}
		if (!paramsCodec || !stateCodec) {
			throw new Error(`Flow process '${this.processId}' must declare .codecs(...)`);
		}
		if (!initialState) {
			throw new Error(`Flow process '${this.processId}' must declare .initialState(...)`);
		}

		const turns: TurnDefinitionRecord<TParams, TState> = {};
		for (const turn of this.turns) {
			if (Object.hasOwn(turns, turn.id)) {
				throw new Error(`Flow process '${this.processId}' declares duplicate turn '${turn.id}'`);
			}
			turns[turn.id] = turn.definition;
		}

		const input: DefinedProcessInput<TParams, TState> = {
			...this.configuration,
			id: this.processId,
			displayName,
			entry,
			...(this.alternateEntryTurnIds.length > 0
				? { alternateEntries: [...this.alternateEntryTurnIds] }
				: {}),
			paramsCodec,
			stateCodec,
			initialState,
			turns,
			...(this.serverHooks.length > 0 ? { server: chainHooks(this.serverHooks) } : {}),
			...(this.uiHooks.length > 0 ? { ui: chainHooks(this.uiHooks) } : {}),
			...(this.launcherHooks.length > 0 ? { launchers: chainHooks(this.launcherHooks) } : {}),
			...(this.watcherHooks.length > 0 ? { watchers: chainHooks(this.watcherHooks) } : {}),
		};
		return defineProcess(input);
	}
}

/** @public */
export const flow = {
	/** @public */
	llm<TParams = unknown, TState = unknown>(turnId: TurnId): LlmFlowBuilder<TParams, TState> {
		return new LlmFlowBuilder<TParams, TState>(turnId);
	},
	/** Run an LLM turn sequentially over frozen items, then collect and route once. @public */
	mappedLlm<TParams = unknown, TState = unknown, TItem = unknown, TResult = unknown>(
		turnId: TurnId,
		items: FlowForEachOptions<TParams, TState, TItem, TResult>,
	): MappedLlmFlowBuilder<TParams, TState, TItem, TResult> {
		return new MappedLlmFlowBuilder<TParams, TState, TItem, TResult>(turnId, items);
	},
	/** @public */
	automatic<TParams = unknown, TState = unknown>(
		turnId: TurnId,
	): AutomaticFlowBuilder<TParams, TState> {
		return new AutomaticFlowBuilder<TParams, TState>(turnId);
	},
	/** @public */
	human<TParams = unknown, TState = unknown>(turnId: TurnId): HumanFlowBuilder<TParams, TState> {
		return new HumanFlowBuilder<TParams, TState>(turnId);
	},
	/** @public */
	external<TParams = unknown, TState = unknown>(
		turnId: TurnId,
	): ExternalFlowBuilder<TParams, TState> {
		return new ExternalFlowBuilder<TParams, TState>(turnId);
	},
	/** @public */
	fragment<TParams = unknown, TState = unknown>(
		name: string,
	): FlowFragmentBuilder<TParams, TState> {
		return new FlowFragmentBuilder<TParams, TState>(name);
	},
	/** @public */
	process<TParams = unknown, TState = unknown>(
		processId: string,
	): FlowProcessBuilder<TParams, TState> {
		return new FlowProcessBuilder<TParams, TState>(processId);
	},
};
