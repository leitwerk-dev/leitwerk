import path from "node:path";
import {
	assertValidProcessProductName,
	humanizeProcessLabel,
	type ProcessInstance,
	type ProcessProject,
	type ProcessSemanticEntryRefKey,
	type ProcessTurnStartSelection,
	type ProcessTurnTerminalLifecycleStatus,
	type TurnId,
	type TurnProgressReport,
} from "@leitwerk-dev/domain";
import type {
	AutomaticTurnDefinition,
	DefinedProcessInput,
	ExternalTurnDefinition,
	HumanTurnDefinition,
	HumanTurnOperatorAttention,
	LlmModelPurpose,
	LlmTurnDefinition,
	ProcessDefinition,
	ProcessEffectPlan,
	ProcessHumanTurnActionSpec,
	ProcessHumanTurnExternalActionSpec,
	ProcessOutcomeEffect,
	ProcessOutcomeExecution,
	ProcessRuntimeTurnContext,
	ProcessToolOutcomeSpec,
	ProcessTurnEndSpec,
	ServerAutomaticTurnDefinition,
	ServerAutomaticTurnRestartBehavior,
	TurnDefinition,
	TurnDefinitionRecord,
} from "./define-process.js";
import { defineProcess } from "./define-process.js";
import type {
	Codec,
	ExternalActionSource,
	ExternalSourceEffect,
	ExternalSourceEffectContext,
	FormDefinition,
	ProcessActionDefinition,
	ProcessLauncherAPI,
	ProcessLauncherDefinition,
	ProcessWatcherAPI,
	ProcessWatcherDefinition,
	RepositoryCredentialProject,
	RepositoryCredentialRequirement,
	ServerProcessAPI,
	UiProcessAPI,
	WorkerCompleteInput,
} from "./extension-api.js";
import type { OutcomeToolParameterSpec, PiBuiltInToolName, ProcessPiConfig } from "./types.js";

type MaybePromise<T> = T | Promise<T>;

export const DEFAULT_PLAN_RESULT_OUTCOME_ID = "plan_saved" as const;
export const DEFAULT_FLOW_PRODUCT_NAME = "default" as const;
const ASSISTANT_OUTPUT_TURN_RESULT = { mode: "assistant_output", required: true } as const;
const OUTCOME_TOOL_MARKDOWN_PARAMETER_NAME = "markdown" as const;
const OUTCOME_TOOL_ARGUMENT_TURN_RESULT = {
	mode: "outcome_tool_argument",
	parameterName: OUTCOME_TOOL_MARKDOWN_PARAMETER_NAME,
	required: true,
} as const;

export interface FlowLlmTurn<
	TParams = unknown,
	TState = unknown,
	TOutcome extends string = string,
> {
	id: TurnId;
	definition: LlmTurnDefinition<TOutcome, TParams, TState>;
}

export interface FlowAutomaticTurn<
	TParams = unknown,
	TState = unknown,
	TOutcome extends string = string,
> {
	id: TurnId;
	definition: AutomaticTurnDefinition<TOutcome, TParams, TState>;
}

export interface FlowServerAutomaticTurn<
	TParams = unknown,
	TState = unknown,
	TOutcome extends string = string,
> {
	id: TurnId;
	definition: ServerAutomaticTurnDefinition<TOutcome, TParams, TState>;
}

export interface FlowHumanTurn<TParams = unknown, TState = unknown> {
	id: TurnId;
	definition: HumanTurnDefinition<TParams, TState>;
}

export interface FlowExternalTurn<TParams = unknown, TState = unknown> {
	id: TurnId;
	definition: ExternalTurnDefinition<TParams, TState>;
}

export type FlowTurn<TParams = unknown, TState = unknown> =
	| FlowLlmTurn<TParams, TState, string>
	| FlowAutomaticTurn<TParams, TState, string>
	| FlowServerAutomaticTurn<TParams, TState, string>
	| FlowHumanTurn<TParams, TState>
	| FlowExternalTurn<TParams, TState>
	| { id: TurnId; definition: TurnDefinition<TParams, TState> };

export interface PlanFieldOptions {
	description?: string;
	requiredErrorCode?: string;
}

export interface PlanAcceptanceCriteriaOptions extends PlanFieldOptions {
	minItems?: number;
	minItemsErrorCode?: string;
}

export interface PlanSavedStateInput<TParams = unknown, TState = unknown> {
	effect: ProcessOutcomeEffect<TParams, TState>;
}

export interface FlowRepoContext {
	key: string;
	fsPath: string;
	workspaceClonePath: string;
	baseBranch: string;
	workBranch: string;
	locator: string;
}

export interface FlowRepoLookup {
	get(key: string): FlowRepoContext;
	optional(key: string): FlowRepoContext | undefined;
	all(): FlowRepoContext[];
}

export interface FlowPromptContext<
	TParams = unknown,
	TState = unknown,
	TConsumedProducts extends string = string,
> {
	process: ProcessInstance;
	projects: readonly ProcessProject[];
	params: TParams;
	state: TState;
	workspaceRoot?: string;
	prompts: {
		initial: string;
	};
	input: Readonly<Partial<Record<TConsumedProducts, string>>>;
	repo: FlowRepoLookup;
}

export interface FlowAutomaticRunContext<TParams = unknown, TState = unknown> {
	process: ProcessInstance;
	projects: readonly ProcessProject[];
	params: TParams;
	state: TState;
	workspaceRoot?: string;
	repo: FlowRepoLookup;
	callIntegrationTool(name: string, args: Record<string, unknown>): Promise<unknown>;
	reportProgress(report: TurnProgressReport): void;
}

export interface FlowLlmOutcomeEffectContext<TParams = unknown, TState = unknown> {
	process: ProcessInstance;
	projects: readonly ProcessProject[];
	params: TParams;
	state: TState;
	output: { content: string | null } | null;
}

export interface FlowAutomaticOutcomeEffectContext<TParams = unknown, TState = unknown> {
	process: ProcessInstance;
	projects: readonly ProcessProject[];
	params: TParams;
	state: TState;
	output: { content: string | null } | null;
}

export interface FlowExternalSourceContext<
	TParams = unknown,
	TState = unknown,
	TEvent = unknown,
	TInput extends Record<string, unknown> = Record<string, unknown>,
> extends ExternalSourceEffectContext<TParams, TState, TEvent, TInput> {}

type FlowOutcomeEffectInput<TParams, TState, TContext> = {
	ctx: TContext;
	event: ProcessOutcomeExecution<TParams, TState>["event"];
	turnId: TurnId;
	outcome: string;
};

type FlowOutcomeEffect<TParams, TState, TContext> = (
	input: FlowOutcomeEffectInput<TParams, TState, TContext>,
) => MaybePromise<ProcessEffectPlan<TState> | undefined>;

type FlowOutcomeStateEffect<TParams, TState, TContext> = (
	input: FlowOutcomeEffectInput<TParams, TState, TContext>,
) => MaybePromise<TState>;

type SnapshotContext<TParams, TState> = {
	process: ProcessInstance;
	projects: readonly ProcessProject[];
	params: TParams;
	state: TState;
};

function textField(input: {
	description: string;
	requiredErrorCode: string;
}): OutcomeToolParameterSpec {
	return {
		type: "string",
		description: input.description,
		required: true,
		requiredErrorCode: input.requiredErrorCode,
	};
}

function stringArrayField(input: {
	description: string;
	requiredErrorCode: string;
	minItems: number;
	minItemsErrorCode: string;
}): OutcomeToolParameterSpec {
	return {
		type: "array",
		description: input.description,
		items: { type: "string" },
		required: true,
		requiredErrorCode: input.requiredErrorCode,
		minItems: input.minItems,
		minItemsErrorCode: input.minItemsErrorCode,
	};
}

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

function isPathInside(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return (
		relative !== "" &&
		relative !== ".." &&
		!relative.startsWith(`..${path.sep}`) &&
		!path.isAbsolute(relative)
	);
}

function safeJoinInside(parent: string, childPath: string, context: string): string {
	const parentPath = path.resolve(parent);
	const targetPath = path.resolve(parentPath, childPath);
	if (!isPathInside(parentPath, targetPath)) {
		throw new Error(`${context} resolves outside '${parentPath}'`);
	}
	return targetPath;
}

function toWorkspaceClonePath(relativePath: string): string {
	return `./${relativePath.split(path.sep).join("/")}`;
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
		workspaceClonePath: toWorkspaceClonePath(relativePath),
	};
}

function resolveRepoByKey(input: {
	projects: readonly ProcessProject[];
	workspaceRoot?: string;
	key: string;
	required: true;
}): FlowRepoContext;
function resolveRepoByKey(input: {
	projects: readonly ProcessProject[];
	workspaceRoot?: string;
	key: string;
	required: false;
}): FlowRepoContext | undefined;
function resolveRepoByKey(input: {
	projects: readonly ProcessProject[];
	workspaceRoot?: string;
	key: string;
	required: boolean;
}): FlowRepoContext | undefined {
	const requestedKey = input.key.trim();
	if (!requestedKey) {
		throw new Error("Flow repo lookup requires a non-empty project key");
	}
	const matches = input.projects.filter((project) => project.key.trim() === requestedKey);
	if (matches.length === 0) {
		if (!input.required) {
			return undefined;
		}
		const availableKeys = input.projects
			.map((project) => project.key.trim())
			.filter((key) => key !== "")
			.join(", ");
		throw new Error(
			`Flow context requires project '${requestedKey}', but this process has no project with that key${
				availableKeys ? ` (available: ${availableKeys})` : ""
			}`,
		);
	}
	if (matches.length > 1) {
		throw new Error(`Flow context found duplicate project key '${requestedKey}'`);
	}
	const project = matches[0];
	const key = project.key.trim();
	if (!key) {
		throw new Error("Flow context requires projects to have non-empty keys");
	}
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
	return {
		get: (key) =>
			resolveRepoByKey({
				projects: input.projects,
				workspaceRoot: input.workspaceRoot,
				key,
				required: true,
			}),
		optional: (key) =>
			resolveRepoByKey({
				projects: input.projects,
				workspaceRoot: input.workspaceRoot,
				key,
				required: false,
			}),
		all: () =>
			input.projects.map((project) =>
				resolveRepoByKey({
					projects: input.projects,
					workspaceRoot: input.workspaceRoot,
					key: project.key,
					required: true,
				}),
			),
	};
}

export function createFlowPromptContext<TParams, TState, TConsumedProducts extends string = string>(
	ctx: ProcessRuntimeTurnContext<TParams, TState>,
	consumedProducts: readonly TConsumedProducts[],
	optionalConsumedProducts: readonly string[] = [],
): FlowPromptContext<TParams, TState, TConsumedProducts> {
	const productInput: Record<string, string> = {};
	for (const productName of consumedProducts) {
		const markdown = ctx.turnResultMarkdownByProduct?.[productName];
		if (typeof markdown !== "string" || markdown.trim() === "") {
			throw new Error(
				`Flow prompt context requires product '${productName}' markdown, but the worker payload did not provide it`,
			);
		}
		productInput[productName] = markdown;
	}
	for (const productName of optionalConsumedProducts) {
		if (productName in productInput) {
			continue;
		}
		const markdown = ctx.turnResultMarkdownByProduct?.[productName];
		if (typeof markdown === "string" && markdown.trim() !== "") {
			productInput[productName] = markdown;
		}
	}
	return {
		process: ctx.process,
		projects: ctx.projects,
		params: ctx.params,
		state: ctx.state,
		...(ctx.workspaceRoot ? { workspaceRoot: ctx.workspaceRoot } : {}),
		prompts: {
			initial: readInitialPrompt(ctx.params),
		},
		input: productInput as Partial<Record<TConsumedProducts, string>>,
		repo: createFlowRepoLookup({
			projects: ctx.projects,
			workspaceRoot: ctx.workspaceRoot,
		}),
	};
}

export function createFlowAutomaticRunContext<TParams, TState>(
	ctx: ProcessRuntimeTurnContext<TParams, TState>,
): FlowAutomaticRunContext<TParams, TState> {
	return {
		process: ctx.process,
		projects: ctx.projects,
		params: ctx.params,
		state: ctx.state,
		...(ctx.workspaceRoot ? { workspaceRoot: ctx.workspaceRoot } : {}),
		repo: createFlowRepoLookup({
			projects: ctx.projects,
			workspaceRoot: ctx.workspaceRoot,
		}),
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

function createFlowLlmOutcomeEffectContext<TParams, TState>(input: {
	ctx: SnapshotContext<TParams, TState>;
	event: ProcessOutcomeExecution<TParams, TState>["event"];
}): FlowLlmOutcomeEffectContext<TParams, TState> {
	return {
		process: input.ctx.process,
		projects: input.ctx.projects,
		params: input.ctx.params,
		state: input.ctx.state,
		output:
			typeof input.event.turnResultMarkdown === "string"
				? { content: input.event.turnResultMarkdown }
				: null,
	};
}

function createFlowAutomaticOutcomeEffectContext<TParams, TState>(input: {
	ctx: SnapshotContext<TParams, TState>;
	event: ProcessOutcomeExecution<TParams, TState>["event"];
}): FlowAutomaticOutcomeEffectContext<TParams, TState> {
	return {
		process: input.ctx.process,
		projects: input.ctx.projects,
		params: input.ctx.params,
		state: input.ctx.state,
		output:
			typeof input.event.turnResultMarkdown === "string"
				? { content: input.event.turnResultMarkdown }
				: null,
	};
}

function wrapLlmOutcomeEffect<TParams, TState>(
	effect: FlowOutcomeEffect<TParams, TState, FlowLlmOutcomeEffectContext<TParams, TState>>,
): ProcessOutcomeEffect<TParams, TState> {
	return (execution) =>
		effect({
			ctx: createFlowLlmOutcomeEffectContext({ ctx: execution.ctx, event: execution.event }),
			event: execution.event,
			turnId: execution.turnId,
			outcome: execution.outcome,
		});
}

function wrapAutomaticOutcomeEffect<TParams, TState>(
	effect: FlowOutcomeEffect<TParams, TState, FlowAutomaticOutcomeEffectContext<TParams, TState>>,
): ProcessOutcomeEffect<TParams, TState> {
	return (execution) =>
		effect({
			ctx: createFlowAutomaticOutcomeEffectContext({ ctx: execution.ctx, event: execution.event }),
			event: execution.event,
			turnId: execution.turnId,
			outcome: execution.outcome,
		});
}

class RouteAndEffectBuilder<TParams, TState, TContext> {
	protected target:
		| { kind: "to"; turnId: TurnId }
		| { kind: "complete" }
		| { kind: "lifecycleStatus"; status: ProcessTurnTerminalLifecycleStatus }
		| null = null;
	protected flowEffect: FlowOutcomeEffect<TParams, TState, TContext> | undefined;

	protected setTarget(
		next:
			| { kind: "to"; turnId: TurnId }
			| { kind: "complete" }
			| { kind: "lifecycleStatus"; status: ProcessTurnTerminalLifecycleStatus }
			| null,
	): this {
		if (this.target && next) {
			throw new Error("Flow route already declares a target");
		}
		this.target = next;
		return this;
	}

	to(turnId: TurnId): this {
		return this.setTarget({ kind: "to", turnId });
	}

	complete(): this {
		return this.setTarget({ kind: "complete" });
	}

	lifecycleStatus(status: ProcessTurnTerminalLifecycleStatus): this {
		return this.setTarget({ kind: "lifecycleStatus", status });
	}

	stay(): this {
		this.target = null;
		return this;
	}

	state(fn: FlowOutcomeStateEffect<TParams, TState, TContext>): this {
		this.flowEffect = async (input) => ({ state: await fn(input) });
		return this;
	}

	effect(fn: FlowOutcomeEffect<TParams, TState, TContext>): this {
		this.flowEffect = fn;
		return this;
	}

	hasRoute(): boolean {
		return this.target !== null;
	}

	protected buildRouteTarget(): {
		to?: TurnId;
		complete?: boolean;
		lifecycleStatus?: ProcessTurnTerminalLifecycleStatus;
	} {
		return buildRouteTargetSpec(this.target);
	}
}

export type FlowTargetSpec =
	| { kind: "to"; turnId: TurnId }
	| { kind: "complete" }
	| { kind: "lifecycleStatus"; status: ProcessTurnTerminalLifecycleStatus }
	| null;

export function buildRouteTargetSpec(target: FlowTargetSpec): {
	to?: TurnId;
	complete?: boolean;
	lifecycleStatus?: ProcessTurnTerminalLifecycleStatus;
} {
	if (!target) {
		return {};
	}
	if (target.kind === "to") {
		return { to: target.turnId };
	}
	if (target.kind === "complete") {
		return { complete: true };
	}
	return { lifecycleStatus: target.status };
}

interface ParameterOptions extends Partial<Omit<OutcomeToolParameterSpec, "type" | "description">> {
	description?: string;
	requiredErrorCode?: string;
}

interface ArrayParameterOptions extends ParameterOptions {
	items?: OutcomeToolParameterSpec["items"];
}

interface EnumParameterOptions extends ParameterOptions {
	values?: readonly string[];
}

interface MarkdownParameterOptions extends ParameterOptions {
	publish?: true;
}

function isStringArray(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

class ParameterizedOutcomeBuilder<TParams, TState, TContext> extends RouteAndEffectBuilder<
	TParams,
	TState,
	TContext
> {
	protected outcomeDescription: string | null = null;
	protected parameters: Record<string, OutcomeToolParameterSpec> = {};
	protected publishedMarkdownParameter: string | null = null;

	description(text: string): this {
		this.outcomeDescription = text;
		return this;
	}

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

	string(name: string, options: string | ParameterOptions = {}): this {
		const resolved = typeof options === "string" ? { description: options } : options;
		return this.parameter(name, {
			...resolved,
			type: "string",
			description: resolved.description ?? "",
		});
	}

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
		return this.parameter(name, {
			...parameterOptions,
			required: publish ? true : resolved.required,
			requiredErrorCode: resolved.requiredErrorCode ?? (publish ? `${name}_required` : undefined),
			type: "string",
			description: resolved.description ?? "",
		});
	}

	requiredString(name: string, options: string | ParameterOptions = {}): this {
		const resolved = this.withRequired(name, options);
		return this.parameter(name, {
			...resolved,
			type: "string",
			description: resolved.description ?? "",
		});
	}

	number(name: string, options: string | ParameterOptions = {}): this {
		const resolved = typeof options === "string" ? { description: options } : options;
		return this.parameter(name, {
			...resolved,
			type: "number",
			description: resolved.description ?? "",
		});
	}

	requiredNumber(name: string, options: string | ParameterOptions = {}): this {
		const resolved = this.withRequired(name, options);
		return this.parameter(name, {
			...resolved,
			type: "number",
			description: resolved.description ?? "",
		});
	}

	boolean(name: string, options: string | ParameterOptions = {}): this {
		const resolved = typeof options === "string" ? { description: options } : options;
		return this.parameter(name, {
			...resolved,
			type: "boolean",
			description: resolved.description ?? "",
		});
	}

	requiredBoolean(name: string, options: string | ParameterOptions = {}): this {
		const resolved = this.withRequired(name, options);
		return this.parameter(name, {
			...resolved,
			type: "boolean",
			description: resolved.description ?? "",
		});
	}

	stringArray(name: string, options: string | ArrayParameterOptions = {}): this {
		const resolved = typeof options === "string" ? { description: options } : options;
		return this.parameter(name, {
			...resolved,
			type: "array",
			description: resolved.description ?? "",
			items: resolved.items ?? { type: "string" },
		});
	}

	requiredStringArray(name: string, options: string | ArrayParameterOptions = {}): this {
		const resolved = this.withRequired(name, options);
		return this.parameter(name, {
			...resolved,
			type: "array",
			description: resolved.description ?? "",
			items: (resolved as ArrayParameterOptions).items ?? { type: "string" },
		});
	}

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

	object(name: string, options: string | ParameterOptions = {}): this {
		const resolved = typeof options === "string" ? { description: options } : options;
		return this.parameter(name, {
			...resolved,
			type: "object",
			description: resolved.description ?? "",
		});
	}

	array(name: string, options: string | ArrayParameterOptions = {}): this {
		const resolved = typeof options === "string" ? { description: options } : options;
		return this.parameter(name, {
			...resolved,
			type: "array",
			description: resolved.description ?? "",
			items: resolved.items ?? { type: "string" },
		});
	}
}

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

	build(): ProcessToolOutcomeSpec<TParams, TState> {
		if (!this.outcomeDescription) {
			throw new Error("LLM outcome tool must declare .description(...)");
		}
		if (this.stateRouting && this.hasRoute()) {
			throw new Error("State-routed outcome cannot declare another route");
		}
		const stateRouting = this.stateRouting;
		return {
			description: this.outcomeDescription,
			parameters: this.parameters,
			...(this.publishedMarkdownParameter
				? {
						publishedProduct: this.publishedMarkdownParameter,
						turnResultMarkdownParameter: this.publishedMarkdownParameter,
					}
				: {}),
			...(stateRouting
				? {
						branches: Object.fromEntries(
							Object.entries(stateRouting.branches).map(([branchId, turnId]) => [
								branchId,
								{ to: turnId },
							]),
						),
						choose: (execution: ProcessOutcomeExecution<TParams, TState>) =>
							stateRouting.choose({
								ctx: createFlowLlmOutcomeEffectContext({
									ctx: execution.ctx,
									event: execution.event,
								}),
								event: execution.event,
								turnId: execution.turnId,
								outcome: execution.outcome,
							}),
					}
				: this.buildRouteTarget()),
			...(this.flowEffect ? { effect: wrapLlmOutcomeEffect(this.flowEffect) } : {}),
		};
	}
}

export class AutomaticOutcomeBuilder<
	TParams = unknown,
	TState = unknown,
> extends ParameterizedOutcomeBuilder<
	TParams,
	TState,
	FlowAutomaticOutcomeEffectContext<TParams, TState>
> {
	private waits = false;

	wait(): this {
		if (this.hasRoute()) throw new Error("Waiting outcome cannot declare another route");
		this.waits = true;
		return this;
	}

	build(): ProcessToolOutcomeSpec<TParams, TState> {
		if (!this.outcomeDescription) {
			throw new Error("Automatic outcome must declare .description(...)");
		}
		const configuredEffect = this.flowEffect
			? wrapAutomaticOutcomeEffect(this.flowEffect)
			: undefined;
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
			description: this.outcomeDescription,
			parameters: this.parameters,
			...(this.publishedMarkdownParameter
				? {
						publishedProduct: this.publishedMarkdownParameter,
						turnResultMarkdownParameter: this.publishedMarkdownParameter,
					}
				: {}),
			...this.buildRouteTarget(),
			...(effect ? { effect } : {}),
		};
	}
}

export class PlanResultBuilder<TParams = unknown, TState = unknown> extends RouteAndEffectBuilder<
	TParams,
	TState,
	FlowLlmOutcomeEffectContext<TParams, TState>
> {
	private resultDescription = "The candidate plan is ready for operator review";
	private summarySpec: OutcomeToolParameterSpec | null = null;
	private acceptanceCriteriaSpec: OutcomeToolParameterSpec | null = null;
	private reviewTurnId: TurnId | null = null;

	description(text: string): this {
		this.resultDescription = text;
		return this;
	}

	summary(options: string | PlanFieldOptions = {}): this {
		const resolved = typeof options === "string" ? { description: options } : options;
		this.summarySpec = textField({
			description: resolved.description ?? "Short summary of the proposed plan",
			requiredErrorCode: resolved.requiredErrorCode ?? "summary_required",
		});
		return this;
	}

	acceptanceCriteria(options: string | PlanAcceptanceCriteriaOptions = {}): this {
		const resolved = typeof options === "string" ? { description: options } : options;
		this.acceptanceCriteriaSpec = stringArrayField({
			description: resolved.description ?? "Acceptance criteria for the requested change",
			requiredErrorCode: resolved.requiredErrorCode ?? "acceptance_criteria_required",
			minItems: resolved.minItems ?? 1,
			minItemsErrorCode: resolved.minItemsErrorCode ?? "acceptance_criteria_required",
		});
		return this;
	}

	review(turnId: TurnId): this {
		this.reviewTurnId = turnId;
		return this.setTarget({ kind: "to", turnId });
	}

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
		const stateEffect = this.flowEffect ? wrapLlmOutcomeEffect(this.flowEffect) : undefined;
		return {
			description: this.resultDescription,
			parameters: {
				summary: this.summarySpec,
				acceptanceCriteria: this.acceptanceCriteriaSpec,
			},
			to: this.reviewTurnId,
			lifecycleIntent: {
				kind: "save_plan_result",
				summaryParam: "summary",
				acceptanceCriteriaParam: "acceptanceCriteria",
				planMarkdownParam: "planMarkdown",
				emitEventType: DEFAULT_PLAN_RESULT_OUTCOME_ID,
				broadcastType: "plan.updated",
				...(stateEffect ? { state: stateEffect } : {}),
			},
		};
	}
}

export class PublishedResultBuilder<TParams = unknown, TState = unknown>
	extends RouteAndEffectBuilder<TParams, TState, FlowLlmOutcomeEffectContext<TParams, TState>>
	implements FlowLlmTurn<TParams, TState, string>
{
	constructor(
		private readonly productName: string,
		private readonly parent?: FlowLlmTurn<TParams, TState, string>,
	) {
		super();
	}

	get id(): TurnId {
		if (!this.parent) {
			throw new Error("Published result builder is not attached to a turn");
		}
		return this.parent.id;
	}

	get definition(): LlmTurnDefinition<string, TParams, TState> {
		if (!this.parent) {
			throw new Error("Published result builder is not attached to a turn");
		}
		return this.parent.definition;
	}

	buildTurnEnd(): ProcessTurnEndSpec<TParams, TState, string> {
		const effect = this.flowEffect ? wrapLlmOutcomeEffect(this.flowEffect) : undefined;
		return {
			outcome: this.productName,
			...this.buildRouteTarget(),
			...(effect ? { effect } : {}),
		};
	}
}

export class LlmTurnEndBuilder<TParams = unknown, TState = unknown>
	extends RouteAndEffectBuilder<TParams, TState, FlowLlmOutcomeEffectContext<TParams, TState>>
	implements FlowLlmTurn<TParams, TState, string>
{
	constructor(
		private readonly outcomeId: string,
		private readonly parent?: FlowLlmTurn<TParams, TState, string>,
	) {
		super();
		if (outcomeId.trim() === "") {
			throw new Error("LLM turn end outcome must be non-empty");
		}
	}

	get id(): TurnId {
		if (!this.parent) {
			throw new Error("LLM turn end builder is not attached to a turn");
		}
		return this.parent.id;
	}

	get definition(): LlmTurnDefinition<string, TParams, TState> {
		if (!this.parent) {
			throw new Error("LLM turn end builder is not attached to a turn");
		}
		return this.parent.definition;
	}

	build(): ProcessTurnEndSpec<TParams, TState, string> {
		const effect = this.flowEffect ? wrapLlmOutcomeEffect(this.flowEffect) : undefined;
		return {
			outcome: this.outcomeId,
			...this.buildRouteTarget(),
			...(effect ? { effect } : {}),
		};
	}
}

type LlmPromptBuilder<TParams, TState, TConsumedProducts extends string> = (
	ctx: FlowPromptContext<TParams, TState, TConsumedProducts>,
) => MaybePromise<string>;

export class LlmFlowBuilder<
	TParams = unknown,
	TState = unknown,
	TConsumedProducts extends string = never,
> implements FlowLlmTurn<TParams, TState, string>
{
	private readonly turnId: TurnId;
	private turnDescription: string | null = null;
	private modelPurposeValue: LlmModelPurpose | undefined;
	private availableTools: readonly PiBuiltInToolName[] = [];
	private availableIntegrationTools: readonly string[] = [];
	private promptBuilder:
		| ((ctx: ProcessRuntimeTurnContext<TParams, TState>) => MaybePromise<string>)
		| null = null;
	private branchType: LlmTurnDefinition<string, TParams, TState>["branchType"] = "primary";
	private context: LlmTurnDefinition<string, TParams, TState>["context"] = "fresh";
	private completionMode: LlmTurnDefinition<string, TParams, TState>["completionMode"] = "turn_end";
	private questionsEnabled = false;
	private startFrom: LlmTurnDefinition<string, TParams, TState>["startFrom"] | undefined;
	private restorePrimaryLeafAfterTurn: boolean | undefined;
	private consumedProductNames: string[] = [];
	private optionalConsumedProductNames: string[] = [];
	private publishedResult: {
		productName: string;
		builder: PublishedResultBuilder<TParams, TState>;
	} | null = null;
	private endResult: LlmTurnEndBuilder<TParams, TState> | null = null;
	private outcomeToolBuilders = new Map<string, OutcomeToolBuilder<TParams, TState>>();

	constructor(turnId: TurnId) {
		this.turnId = turnId;
	}

	get id(): TurnId {
		return this.turnId;
	}

	get definition(): LlmTurnDefinition<string, TParams, TState> {
		return this.buildDefinition();
	}

	description(description: string): this {
		this.turnDescription = description;
		return this;
	}

	modelPurpose(purpose: LlmModelPurpose): this {
		this.modelPurposeValue = purpose;
		return this;
	}

	tools(...tools: readonly PiBuiltInToolName[]): this {
		this.availableTools = tools;
		return this;
	}

	integrationTools(...tools: readonly string[]): this {
		this.availableIntegrationTools = tools.map((tool) => tool.trim());
		return this;
	}

	/** Enable durable operator questions for this LLM turn. */
	askQuestions(): this {
		this.questionsEnabled = true;
		return this;
	}

	freshPrimary(): this {
		this.branchType = "primary";
		this.context = "fresh";
		this.completionMode = "turn_end";
		this.startFrom = undefined;
		this.restorePrimaryLeafAfterTurn = undefined;
		return this;
	}

	freshSeededPrimary(): this {
		this.branchType = "primary";
		this.context = "fresh_seeded";
		this.completionMode = "turn_end";
		this.startFrom = undefined;
		this.restorePrimaryLeafAfterTurn = undefined;
		return this;
	}

	fullPrimary(): this {
		this.branchType = "primary";
		this.context = "full";
		this.completionMode = "turn_end";
		return this;
	}

	rootBranchReview(): this {
		this.branchType = "root_branch";
		this.context = "full";
		this.completionMode = "turn_end";
		this.restorePrimaryLeafAfterTurn = true;
		return this;
	}

	continueFromPrimaryLeaf(): this {
		this.startFrom = {
			kind: "semantic_ref",
			ref: "currentPrimaryPathLeaf",
			fallback: { kind: "current_leaf" },
		};
		return this;
	}

	continueFromReviewBranch(): this {
		this.startFrom = {
			kind: "semantic_ref",
			ref: "review",
			fallback: { kind: "current_leaf" },
		};
		return this;
	}

	continueFromProductBranch(
		productName: string,
		fallback: ProcessTurnStartSelection = { kind: "current_leaf" },
	): this {
		this.startFrom = {
			kind: "product_ref",
			productName: normalizeProductName(productName),
			fallback,
		};
		return this;
	}

	startFromReviewBranch(): this {
		this.startFrom = {
			kind: "semantic_ref",
			ref: "review",
			fallback: { kind: "session_root" },
		};
		return this;
	}

	startFromProductBranch(
		productName: string,
		fallback: ProcessTurnStartSelection = { kind: "session_root" },
	): this {
		this.startFrom = {
			kind: "product_ref",
			productName: normalizeProductName(productName),
			fallback,
		};
		return this;
	}

	startFromRoot(): this {
		this.startFrom = { kind: "session_root" };
		return this;
	}

	consume<TProductName extends string>(
		productName: TProductName,
	): LlmFlowBuilder<TParams, TState, TConsumedProducts | TProductName> {
		const normalized = normalizeProductName(productName);
		if (!this.consumedProductNames.includes(normalized)) {
			this.consumedProductNames.push(normalized);
		}
		return this as unknown as LlmFlowBuilder<TParams, TState, TConsumedProducts | TProductName>;
	}

	optionalConsume<TProductName extends string>(
		productName: TProductName,
	): LlmFlowBuilder<TParams, TState, TConsumedProducts | TProductName> {
		const normalized = normalizeProductName(productName);
		if (!this.optionalConsumedProductNames.includes(normalized)) {
			this.optionalConsumedProductNames.push(normalized);
		}
		return this as unknown as LlmFlowBuilder<TParams, TState, TConsumedProducts | TProductName>;
	}

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

	buildPrompt(fn: LlmPromptBuilder<TParams, TState, TConsumedProducts>): this {
		this.promptBuilder = (ctx) =>
			fn(
				createFlowPromptContext(
					ctx,
					this.consumedProductNames as TConsumedProducts[],
					this.optionalConsumedProductNames,
				),
			);
		return this;
	}

	prompt(prompt: (ctx: ProcessRuntimeTurnContext<TParams, TState>) => MaybePromise<string>): this {
		this.promptBuilder = prompt;
		return this;
	}

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

	private buildBaseDefinition() {
		if (!this.turnDescription) {
			throw new Error(`LLM turn '${this.turnId}' must declare .description(...)`);
		}
		const prompt = this.promptBuilder;
		if (!prompt) {
			throw new Error(`LLM turn '${this.turnId}' must declare .buildPrompt(...)`);
		}
		return {
			kind: "llm" as const,
			description: this.turnDescription,
			...(this.modelPurposeValue ? { modelPurpose: this.modelPurposeValue } : {}),
			availableTools: this.availableTools,
			...(this.availableIntegrationTools.length > 0
				? { integrationTools: this.availableIntegrationTools }
				: {}),
			...(this.questionsEnabled ? { askQuestions: true as const } : {}),
			completionMode: this.completionMode,
			branchType: this.branchType,
			context: this.context,
			...(this.startFrom ? { startFrom: this.startFrom } : {}),
			...(this.restorePrimaryLeafAfterTurn !== undefined
				? { restorePrimaryLeafAfterTurn: this.restorePrimaryLeafAfterTurn }
				: {}),
			prompt,
		};
	}

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

	private buildDefinition(): LlmTurnDefinition<string, TParams, TState> {
		const definition = this.buildBaseDefinition();
		const hasOutcomeTools = this.outcomeToolBuilders.size > 0;
		const explicitTurnEnd = this.endResult;
		const published = this.publishedResult;
		const outcomes: Record<string, ProcessToolOutcomeSpec<TParams, TState>> = {};
		for (const [outcomeId, builder] of this.outcomeToolBuilders) {
			outcomes[outcomeId] = builder.build();
		}
		const outcomePublishedProducts = new Set(
			Object.values(outcomes)
				.map((outcome) => outcome.publishedProduct)
				.filter((productName): productName is string => typeof productName === "string"),
		);
		const hasOutcomePublishedProduct = outcomePublishedProducts.size > 0;
		let turnEnd: ProcessTurnEndSpec<TParams, TState, string> | undefined;
		let resultSemanticRef: "plan" | "review" | undefined = outcomePublishedProducts.has("review")
			? "review"
			: outcomePublishedProducts.has("plan")
				? "plan"
				: undefined;
		let turnResultMarkdown: LlmTurnDefinition<string, TParams, TState>["turnResultMarkdown"];
		let publishedProduct: string | undefined;

		if (published) {
			publishedProduct = published.productName;
			if (published.productName === "plan") {
				resultSemanticRef = "plan";
			}
			if (published.productName === "review") {
				resultSemanticRef = "review";
			}
			const publishHasRoute = published.builder.hasRoute();
			if (publishHasRoute && hasOutcomeTools) {
				throw new Error(
					`LLM turn '${this.turnId}' cannot route published product '${published.productName}' and declare outcome tools in flow v1`,
				);
			}
			if (publishHasRoute && !hasOutcomeTools) {
				turnResultMarkdown = ASSISTANT_OUTPUT_TURN_RESULT;
				turnEnd = published.builder.buildTurnEnd();
			}
			if (!publishHasRoute && hasOutcomeTools) {
				turnResultMarkdown = OUTCOME_TOOL_ARGUMENT_TURN_RESULT;
			}
			if (!publishHasRoute && !hasOutcomeTools) {
				throw new Error(
					`LLM turn '${this.turnId}' publishes product '${published.productName}' but declares no route or outcome tool completion path`,
				);
			}
		} else if (hasOutcomeTools && !hasOutcomePublishedProduct) {
			turnResultMarkdown = OUTCOME_TOOL_ARGUMENT_TURN_RESULT;
		} else if (explicitTurnEnd) {
			turnResultMarkdown = ASSISTANT_OUTPUT_TURN_RESULT;
		}

		if (hasOutcomeTools) {
			for (const [outcomeId, outcome] of Object.entries(outcomes)) {
				if (OUTCOME_TOOL_MARKDOWN_PARAMETER_NAME in outcome.parameters) {
					throw new Error(
						`LLM turn '${this.turnId}' outcome tool '${outcomeId}' cannot declare reserved markdown parameter '${OUTCOME_TOOL_MARKDOWN_PARAMETER_NAME}'`,
					);
				}
			}
		}

		if (explicitTurnEnd) {
			if (turnEnd || Object.keys(outcomes).length > 0) {
				throw new Error(`LLM turn '${this.turnId}' cannot declare multiple completion paths`);
			}
			turnEnd = explicitTurnEnd.build();
		}
		if (Object.keys(outcomes).length === 0 && !turnEnd) {
			throw new Error(`LLM turn '${this.turnId}' must declare a completion path`);
		}

		return {
			...definition,
			...(Object.keys(outcomes).length > 0 ? { outcomes } : {}),
			...(turnEnd ? { turnEnd } : {}),
			...(turnResultMarkdown ? { turnResultMarkdown } : {}),
			...(resultSemanticRef ? { resultSemanticRef } : {}),
			...(publishedProduct ? { publishedProduct } : {}),
			...(this.consumedProductNames.length > 0
				? { consumedProducts: [...this.consumedProductNames] }
				: {}),
			...(this.optionalConsumedProductNames.length > 0
				? { optionalConsumedProducts: [...this.optionalConsumedProductNames] }
				: {}),
		};
	}
}

export class AutomaticFlowBuilder<TParams = unknown, TState = unknown>
	implements FlowAutomaticTurn<TParams, TState, string>
{
	private readonly turnId: TurnId;
	private turnDescription: string | null = null;
	private runFn:
		| ((ctx: FlowAutomaticRunContext<TParams, TState>) => MaybePromise<WorkerCompleteInput<string>>)
		| null = null;
	private outcomeBuilders = new Map<string, AutomaticOutcomeBuilder<TParams, TState>>();
	private availableIntegrationTools: readonly string[] = [];
	private externalActionBuilders = new Map<
		string,
		ExternalActionBuilder<TParams, TState, unknown, Record<string, unknown>>
	>();

	constructor(turnId: TurnId) {
		this.turnId = turnId;
	}

	get id(): TurnId {
		return this.turnId;
	}

	get definition(): AutomaticTurnDefinition<string, TParams, TState> {
		return this.buildDefinition();
	}

	description(description: string): this {
		this.turnDescription = description;
		return this;
	}

	run(
		fn: (
			ctx: FlowAutomaticRunContext<TParams, TState>,
		) => MaybePromise<WorkerCompleteInput<string>>,
	): this {
		this.runFn = fn;
		return this;
	}

	integrationTools(...tools: readonly string[]): this {
		this.availableIntegrationTools = tools.map((tool) => tool.trim());
		return this;
	}

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
		if (this.externalActionBuilders.has(externalActionId))
			throw new Error(
				`Automatic turn '${this.turnId}' declares duplicate external action '${externalActionId}'`,
			);
		const builder = new ExternalActionBuilder(externalActionId, source);
		configure(builder);
		this.externalActionBuilders.set(
			externalActionId,
			builder as unknown as ExternalActionBuilder<
				TParams,
				TState,
				unknown,
				Record<string, unknown>
			>,
		);
		return this;
	}

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

	private buildDefinition(): AutomaticTurnDefinition<string, TParams, TState> {
		if (!this.turnDescription) {
			throw new Error(`Automatic turn '${this.turnId}' must declare .description(...)`);
		}
		if (!this.runFn) {
			throw new Error(`Automatic turn '${this.turnId}' must declare .run(...)`);
		}
		if (this.outcomeBuilders.size === 0) {
			throw new Error(`Automatic turn '${this.turnId}' must declare at least one outcome`);
		}
		const outcomes: Record<string, ProcessToolOutcomeSpec<TParams, TState>> = {};
		for (const [outcomeId, builder] of this.outcomeBuilders) {
			outcomes[outcomeId] = builder.build();
		}
		const runFn = this.runFn;
		return {
			kind: "automatic",
			description: this.turnDescription,
			...(this.availableIntegrationTools.length > 0
				? { integrationTools: this.availableIntegrationTools }
				: {}),
			...(this.externalActionBuilders.size > 0
				? {
						externalActions: Object.fromEntries(
							[...this.externalActionBuilders.entries()].map(([id, builder]) => [
								id,
								builder.build(),
							]),
						),
					}
				: {}),
			outcomes,
			run: (ctx) => runFn(createFlowAutomaticRunContext(ctx)),
		};
	}
}

export class ServerAutomaticFlowBuilder<TParams = unknown, TState = unknown>
	implements FlowServerAutomaticTurn<TParams, TState, string>
{
	private readonly turnId: TurnId;
	private turnDescription: string | null = null;
	private restartBehaviorValue: ServerAutomaticTurnRestartBehavior | undefined;
	private runFn:
		| ((ctx: FlowAutomaticRunContext<TParams, TState>) => MaybePromise<WorkerCompleteInput<string>>)
		| null = null;
	private outcomeBuilders = new Map<string, AutomaticOutcomeBuilder<TParams, TState>>();

	constructor(turnId: TurnId) {
		this.turnId = turnId;
	}

	get id(): TurnId {
		return this.turnId;
	}

	get definition(): ServerAutomaticTurnDefinition<string, TParams, TState> {
		return this.buildDefinition();
	}

	description(description: string): this {
		this.turnDescription = description;
		return this;
	}

	run(
		fn: (
			ctx: FlowAutomaticRunContext<TParams, TState>,
		) => MaybePromise<WorkerCompleteInput<string> & { state?: TState }>,
	): this {
		this.runFn = fn;
		return this;
	}

	restartBehavior(behavior: ServerAutomaticTurnRestartBehavior): this {
		this.restartBehaviorValue = behavior;
		return this;
	}

	outcome(
		id: string,
		configure: (
			outcome: AutomaticOutcomeBuilder<TParams, TState>,
		) => AutomaticOutcomeBuilder<TParams, TState> | undefined,
	): this {
		if (id.trim() === "") {
			throw new Error(`Server automatic turn '${this.turnId}' declares an empty outcome id`);
		}
		if (this.outcomeBuilders.has(id)) {
			throw new Error(`Server automatic turn '${this.turnId}' declares duplicate outcome '${id}'`);
		}
		const builder = new AutomaticOutcomeBuilder<TParams, TState>();
		configure(builder);
		this.outcomeBuilders.set(id, builder);
		return this;
	}

	private buildDefinition(): ServerAutomaticTurnDefinition<string, TParams, TState> {
		if (!this.turnDescription) {
			throw new Error(`Server automatic turn '${this.turnId}' must declare .description(...)`);
		}
		if (!this.runFn) {
			throw new Error(`Server automatic turn '${this.turnId}' must declare .run(...)`);
		}
		if (this.outcomeBuilders.size === 0) {
			throw new Error(`Server automatic turn '${this.turnId}' must declare at least one outcome`);
		}
		const outcomes: Record<string, ProcessToolOutcomeSpec<TParams, TState>> = {};
		for (const [outcomeId, builder] of this.outcomeBuilders) {
			outcomes[outcomeId] = builder.build();
		}
		const runFn = this.runFn;
		return {
			kind: "server_automatic",
			description: this.turnDescription,
			outcomes,
			...(this.restartBehaviorValue ? { restartBehavior: this.restartBehaviorValue } : {}),
			run: (ctx) =>
				runFn(createFlowAutomaticRunContext(ctx as ProcessRuntimeTurnContext<TParams, TState>)),
		};
	}
}

function formFieldPublishedProductName(field: FormDefinition["fields"][number]): string | null {
	if (!field.publish) {
		return null;
	}
	return normalizeProductName(
		typeof field.publish === "object" && field.publish.product ? field.publish.product : field.id,
	);
}

function inferActionLabel(actionId: string): string {
	return humanizeProcessLabel(actionId);
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

export class HumanActionBuilder<TParams = unknown, TState = unknown> {
	private spec: Record<string, unknown> = {};

	constructor(private readonly actionId: string) {}

	label(label: string): this {
		this.spec.label = label;
		return this;
	}

	description(description: string): this {
		this.spec.description = description;
		return this;
	}

	acceptanceState(state: ProcessHumanTurnActionSpec<TParams, TState>["acceptanceState"]): this {
		this.spec.acceptanceState = state;
		return this;
	}

	form(form: FormDefinition): this {
		this.spec.form = form;
		return this;
	}

	to(turnId: TurnId): this {
		this.spec.to = turnId;
		return this;
	}

	complete(): this {
		this.spec.complete = true;
		return this;
	}

	lifecycleStatus(status: ProcessTurnTerminalLifecycleStatus): this {
		this.spec.lifecycleStatus = status;
		return this;
	}

	trigger(trigger: string): this {
		this.spec.trigger = trigger;
		return this;
	}

	schedulable(value = true): this {
		this.spec.schedulable = value;
		return this;
	}

	effect(effect: ProcessHumanTurnActionSpec<TParams, TState>["effect"]): this {
		this.spec.effect = effect;
		return this;
	}

	build(): ProcessHumanTurnActionSpec<TParams, TState> {
		return {
			label:
				typeof this.spec.label === "string" ? this.spec.label : inferActionLabel(this.actionId),
			acceptanceState:
				(this.spec.acceptanceState as
					| ProcessHumanTurnActionSpec<TParams, TState>["acceptanceState"]
					| undefined) ?? inferAcceptanceState(this.actionId),
			...this.spec,
		} as ProcessHumanTurnActionSpec<TParams, TState>;
	}
}

export class ExternalActionBuilder<
	TParams = unknown,
	TState = unknown,
	TEvent = unknown,
	TInput extends Record<string, unknown> = Record<string, unknown>,
> {
	private spec: Partial<ProcessHumanTurnExternalActionSpec<TParams, TState, TEvent, TInput>>;

	constructor(actionId: string, source: ExternalActionSource<TParams, TState, TEvent, TInput>) {
		this.spec = { id: actionId, source };
	}

	label(label: string): this {
		this.spec.label = label;
		return this;
	}

	description(description: string): this {
		this.spec.description = description;
		return this;
	}

	when(condition: NonNullable<ProcessHumanTurnExternalActionSpec<TParams, TState>["when"]>): this {
		this.spec.when = condition;
		return this;
	}

	to(turnId: TurnId): this {
		this.spec.to = turnId;
		return this;
	}

	complete(): this {
		this.spec.complete = true;
		return this;
	}

	lifecycleStatus(status: ProcessTurnTerminalLifecycleStatus): this {
		this.spec.lifecycleStatus = status;
		return this;
	}

	publishInput(productName: string, options: { inputField: string }): this {
		this.spec.publishInput = {
			productName: normalizeProductName(productName),
			inputField: options.inputField,
		};
		return this;
	}

	effect(effect: ExternalSourceEffect<TParams, TState, TEvent, TInput>): this {
		this.spec.effect = effect;
		return this;
	}

	build(): ProcessHumanTurnExternalActionSpec<TParams, TState, TEvent, TInput> {
		return this.spec as ProcessHumanTurnExternalActionSpec<TParams, TState, TEvent, TInput>;
	}
}

export class HumanFlowBuilder<TParams = unknown, TState = unknown>
	implements FlowHumanTurn<TParams, TState>
{
	private turnDescription: string | null = null;
	private reviewProductName: string | undefined;
	private reviewSemanticRef: ProcessSemanticEntryRefKey | undefined;
	private operatorAttentionValue: HumanTurnOperatorAttention | undefined;
	private turnCommentary: string | undefined;
	private notes: HumanTurnDefinition<TParams, TState>["notesFields"] | undefined;
	private actions = new Map<string, HumanActionBuilder<TParams, TState>>();
	private externalActionBuilders = new Map<
		string,
		ExternalActionBuilder<TParams, TState, unknown, Record<string, unknown>>
	>();

	constructor(private readonly turnId: TurnId) {}

	get id(): TurnId {
		return this.turnId;
	}

	get definition(): HumanTurnDefinition<TParams, TState> {
		if (!this.turnDescription) {
			throw new Error(`Human turn '${this.turnId}' must declare .description(...)`);
		}
		return {
			kind: "human",
			description: this.turnDescription,
			...(this.reviewProductName ? { reviewProduct: this.reviewProductName } : {}),
			...(this.reviewSemanticRef ? { reviewSemanticRef: this.reviewSemanticRef } : {}),
			...(this.operatorAttentionValue ? { operatorAttention: this.operatorAttentionValue } : {}),
			...(this.notes ? { notesFields: this.notes } : {}),
			...(this.turnCommentary ? { commentary: this.turnCommentary } : {}),
			actions: Object.fromEntries(
				[...this.actions.entries()].map(([actionId, builder]) => [actionId, builder.build()]),
			),
			...(this.externalActionBuilders.size > 0
				? {
						externalActions: Object.fromEntries(
							[...this.externalActionBuilders.entries()].map(([actionId, builder]) => [
								actionId,
								builder.build(),
							]),
						),
					}
				: {}),
		};
	}

	description(description: string): this {
		this.turnDescription = description;
		return this;
	}

	reviewProduct(productName: string): this {
		const normalized = normalizeProductName(productName);
		this.reviewProductName = normalized;
		this.reviewSemanticRef =
			normalized === "plan" ? "plan" : normalized === "review" ? "review" : undefined;
		return this;
	}

	operatorAttention(attention: HumanTurnOperatorAttention): this {
		this.operatorAttentionValue = attention;
		return this;
	}

	commentary(commentary: string): this {
		this.turnCommentary = commentary;
		return this;
	}

	notesFields(notes: HumanTurnDefinition<TParams, TState>["notesFields"]): this {
		this.notes = notes;
		return this;
	}

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
				`Human turn '${this.turnId}' declares duplicate external action '${externalActionId}'`,
			);
		}
		const builder = new ExternalActionBuilder<TParams, TState, TEvent, TInput>(
			externalActionId,
			source,
		);
		configure(builder);
		this.externalActionBuilders.set(
			externalActionId,
			builder as unknown as ExternalActionBuilder<
				TParams,
				TState,
				unknown,
				Record<string, unknown>
			>,
		);
		return this;
	}
}

export class ExternalRouteBuilder<
	TParams = unknown,
	TState = unknown,
	TEvent = unknown,
	TInput extends Record<string, unknown> = Record<string, unknown>,
> implements FlowExternalTurn<TParams, TState>
{
	private externalEffect: ExternalSourceEffect<TParams, TState, TEvent, TInput> | undefined;
	private target:
		| { kind: "to"; turnId: TurnId }
		| { kind: "complete" }
		| { kind: "lifecycleStatus"; status: ProcessTurnTerminalLifecycleStatus }
		| null = null;
	constructor(
		private readonly parent: ExternalFlowBuilder<TParams, TState>,
		private readonly source: ExternalActionSource<TParams, TState, TEvent, TInput>,
	) {}

	get id(): TurnId {
		return this.parent.id;
	}

	get definition(): ExternalTurnDefinition<TParams, TState> {
		return this.parent.definition;
	}

	private setTarget(
		next:
			| { kind: "to"; turnId: TurnId }
			| { kind: "complete" }
			| { kind: "lifecycleStatus"; status: ProcessTurnTerminalLifecycleStatus },
	): this {
		if (this.target) {
			throw new Error("External source route already declares a target");
		}
		this.target = next;
		return this;
	}

	to(turnId: TurnId): this {
		return this.setTarget({ kind: "to", turnId });
	}

	complete(): this {
		return this.setTarget({ kind: "complete" });
	}

	lifecycleStatus(status: ProcessTurnTerminalLifecycleStatus): this {
		return this.setTarget({ kind: "lifecycleStatus", status });
	}

	state(
		fn: (input: {
			ctx: FlowExternalSourceContext<TParams, TState, TEvent, TInput>;
			event: TEvent;
			input: TInput;
		}) => MaybePromise<TState>,
	): this {
		this.externalEffect = async (ctx) => ({
			state: await fn({ ctx, event: ctx.event, input: ctx.input }),
		});
		return this;
	}

	effect(
		fn: (input: {
			ctx: FlowExternalSourceContext<TParams, TState, TEvent, TInput>;
			event: TEvent;
			input: TInput;
		}) => MaybePromise<ProcessEffectPlan<TState> | undefined>,
	): this {
		this.externalEffect = (ctx) => fn({ ctx, event: ctx.event, input: ctx.input });
		return this;
	}

	private buildRouteTarget(): {
		to?: TurnId;
		complete?: boolean;
		lifecycleStatus?: ProcessTurnTerminalLifecycleStatus;
	} {
		return buildRouteTargetSpec(this.target);
	}

	build() {
		return {
			source: this.source,
			...this.buildRouteTarget(),
			...(this.externalEffect ? { effect: this.externalEffect } : {}),
		};
	}
}

export class ExternalFlowBuilder<TParams = unknown, TState = unknown>
	implements FlowExternalTurn<TParams, TState>
{
	private turnDescription: string | null = null;
	private routeBuilders: ExternalRouteBuilder<TParams, TState, unknown, Record<string, unknown>>[] =
		[];

	constructor(private readonly turnId: TurnId) {}

	get id(): TurnId {
		return this.turnId;
	}

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

	description(description: string): this {
		this.turnDescription = description;
		return this;
	}

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

type Hook<TApi> = (api: TApi) => void;

export abstract class FlowComponentBuilder<TParams = unknown, TState = unknown> {
	readonly turns: FlowTurn<TParams, TState>[] = [];
	readonly serverHooks: Hook<ServerProcessAPI<TParams, TState>>[] = [];
	readonly uiHooks: Hook<UiProcessAPI<TParams, TState>>[] = [];
	readonly launcherHooks: Hook<ProcessLauncherAPI<TParams>>[] = [];
	readonly watcherHooks: Hook<ProcessWatcherAPI<TParams>>[] = [];

	turn(turn: FlowTurn<TParams, TState>): this {
		this.turns.push(turn);
		return this;
	}

	server(hook: Hook<ServerProcessAPI<TParams, TState>>): this {
		this.serverHooks.push(hook);
		return this;
	}

	action(definition: ProcessActionDefinition<TParams, TState>): this {
		this.serverHooks.push((api) => api.action(definition));
		return this;
	}

	ui(hook: Hook<UiProcessAPI<TParams, TState>>): this {
		this.uiHooks.push(hook);
		return this;
	}

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

export class FlowFragmentBuilder<TParams = unknown, TState = unknown> extends FlowComponentBuilder<
	TParams,
	TState
> {
	readonly name: string;

	constructor(name: string) {
		super();
		if (name.trim() === "") {
			throw new Error("Flow fragment name must be non-empty");
		}
		this.name = name;
	}
}

export class FlowProcessBuilder<TParams = unknown, TState = unknown> extends FlowComponentBuilder<
	TParams,
	TState
> {
	private readonly processId: string;
	private processDisplayName: string | null = null;
	private entryTurnId: TurnId | null = null;
	private readonly alternateEntryTurnIds: TurnId[] = [];
	private happyPathTurnIds: readonly TurnId[] | null = null;
	private paramsCodec: Codec<TParams> | null = null;
	private stateCodec: Codec<TState> | null = null;
	private initialStateFn: ((params: TParams) => TState) | null = null;
	private repositoryCredentialsFn:
		| ((input: {
				params: TParams;
				projects: readonly RepositoryCredentialProject[];
		  }) => readonly RepositoryCredentialRequirement[])
		| undefined;
	private processPiConfig: ProcessPiConfig | undefined;

	constructor(processId: string) {
		super();
		if (processId.trim() === "") {
			throw new Error("Flow process id must be non-empty");
		}
		this.processId = processId;
	}

	displayName(displayName: string): this {
		this.processDisplayName = displayName;
		return this;
	}

	entry(turnId: TurnId): this {
		this.entryTurnId = turnId;
		return this;
	}

	/** Declare an additional turn that launchers may select as the first turn. */
	alternateEntry(turnId: TurnId): this {
		this.alternateEntryTurnIds.push(turnId);
		return this;
	}

	/**
	 * Declare the happy path: the ordered spine of turns a successful run walks
	 * through. Flow diagrams render this as the main line. Must start at the entry
	 * turn and reference only declared turns without repeats.
	 */
	happyPath(...turnIds: readonly TurnId[]): this {
		this.happyPathTurnIds = turnIds;
		return this;
	}

	codecs(input: { params: Codec<TParams>; state: Codec<TState> }): this {
		this.paramsCodec = input.params;
		this.stateCodec = input.state;
		return this;
	}

	initialState(fn: (params: TParams) => TState): this {
		this.initialStateFn = fn;
		return this;
	}

	repositoryCredentials(
		fn: (input: {
			params: TParams;
			projects: readonly RepositoryCredentialProject[];
		}) => readonly RepositoryCredentialRequirement[],
	): this {
		this.repositoryCredentialsFn = fn;
		return this;
	}

	piConfig(config: ProcessPiConfig): this {
		this.processPiConfig = config;
		return this;
	}

	use(fragment: FlowFragmentBuilder<TParams, TState>): this {
		this.turns.push(...fragment.turns);
		this.serverHooks.push(...fragment.serverHooks);
		this.uiHooks.push(...fragment.uiHooks);
		this.launcherHooks.push(...fragment.launcherHooks);
		this.watcherHooks.push(...fragment.watcherHooks);
		return this;
	}

	define(): ProcessDefinition<TParams, TState> {
		if (!this.processDisplayName) {
			throw new Error(`Flow process '${this.processId}' must declare .displayName(...)`);
		}
		if (!this.entryTurnId) {
			throw new Error(`Flow process '${this.processId}' must declare .entry(turnId)`);
		}
		if (!this.paramsCodec || !this.stateCodec) {
			throw new Error(`Flow process '${this.processId}' must declare .codecs(...)`);
		}
		if (!this.initialStateFn) {
			throw new Error(`Flow process '${this.processId}' must declare .initialState(...)`);
		}

		const turns: TurnDefinitionRecord<TParams, TState> = {};
		for (const turn of this.turns) {
			if (Object.hasOwn(turns, turn.id)) {
				throw new Error(`Flow process '${this.processId}' declares duplicate turn '${turn.id}'`);
			}
			turns[turn.id] = turn.definition;
		}

		const publishedProducts = new Set<string>();
		for (const turnDef of Object.values(turns)) {
			if (turnDef.kind === "llm") {
				if (turnDef.publishedProduct) {
					normalizeProductName(turnDef.publishedProduct);
					publishedProducts.add(turnDef.publishedProduct);
				}
				for (const outcome of Object.values(turnDef.outcomes ?? {})) {
					if (outcome?.publishedProduct) {
						normalizeProductName(outcome.publishedProduct);
						publishedProducts.add(outcome.publishedProduct);
					}
				}
			}
			if (turnDef.kind === "human") {
				for (const action of Object.values(turnDef.actions)) {
					for (const field of action.form?.fields ?? []) {
						const productName = formFieldPublishedProductName(field);
						if (productName) {
							publishedProducts.add(productName);
						}
					}
				}
				for (const externalAction of Object.values(turnDef.externalActions ?? {})) {
					if (externalAction.publishInput) {
						publishedProducts.add(normalizeProductName(externalAction.publishInput.productName));
					}
				}
			}
		}
		for (const [turnId, turnDef] of Object.entries(turns)) {
			if (turnDef.kind !== "llm") {
				continue;
			}
			for (const productName of [
				...(turnDef.consumedProducts ?? []),
				...(turnDef.optionalConsumedProducts ?? []),
			]) {
				normalizeProductName(productName);
				if (!publishedProducts.has(productName)) {
					throw new Error(
						`Flow process '${this.processId}' turn '${turnId}' consumes product '${productName}' that is never published by this process`,
					);
				}
			}
		}

		const input: DefinedProcessInput<TParams, TState> = {
			id: this.processId,
			displayName: this.processDisplayName,
			entry: this.entryTurnId,
			...(this.alternateEntryTurnIds.length > 0
				? { alternateEntries: [...this.alternateEntryTurnIds] }
				: {}),
			...(this.happyPathTurnIds ? { happyPath: [...this.happyPathTurnIds] } : {}),
			paramsCodec: this.paramsCodec,
			stateCodec: this.stateCodec,
			initialState: this.initialStateFn,
			...(this.repositoryCredentialsFn
				? { repositoryCredentials: this.repositoryCredentialsFn }
				: {}),
			...(this.processPiConfig ? { piConfig: this.processPiConfig } : {}),
			turns,
			...(this.serverHooks.length > 0
				? {
						server: (api) => {
							for (const hook of this.serverHooks) {
								hook(api);
							}
						},
					}
				: {}),
			...(this.uiHooks.length > 0
				? {
						ui: (api) => {
							for (const hook of this.uiHooks) {
								hook(api);
							}
						},
					}
				: {}),
			...(this.launcherHooks.length > 0
				? {
						launchers: (api) => {
							for (const hook of this.launcherHooks) {
								hook(api);
							}
						},
					}
				: {}),
			...(this.watcherHooks.length > 0
				? {
						watchers: (api) => {
							for (const hook of this.watcherHooks) {
								hook(api);
							}
						},
					}
				: {}),
		};
		return defineProcess(input);
	}
}

export const flow = {
	llm<TParams = unknown, TState = unknown>(turnId: TurnId): LlmFlowBuilder<TParams, TState> {
		return new LlmFlowBuilder<TParams, TState>(turnId);
	},
	automatic<TParams = unknown, TState = unknown>(
		turnId: TurnId,
	): AutomaticFlowBuilder<TParams, TState> {
		return new AutomaticFlowBuilder<TParams, TState>(turnId);
	},
	serverAutomatic<TParams = unknown, TState = unknown>(
		turnId: TurnId,
	): ServerAutomaticFlowBuilder<TParams, TState> {
		return new ServerAutomaticFlowBuilder<TParams, TState>(turnId);
	},
	human<TParams = unknown, TState = unknown>(turnId: TurnId): HumanFlowBuilder<TParams, TState> {
		return new HumanFlowBuilder<TParams, TState>(turnId);
	},
	external<TParams = unknown, TState = unknown>(
		turnId: TurnId,
	): ExternalFlowBuilder<TParams, TState> {
		return new ExternalFlowBuilder<TParams, TState>(turnId);
	},
	fragment<TParams = unknown, TState = unknown>(
		name: string,
	): FlowFragmentBuilder<TParams, TState> {
		return new FlowFragmentBuilder<TParams, TState>(name);
	},
	process<TParams = unknown, TState = unknown>(
		processId: string,
	): FlowProcessBuilder<TParams, TState> {
		return new FlowProcessBuilder<TParams, TState>(processId);
	},
};
