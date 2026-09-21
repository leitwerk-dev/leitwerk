import type { ProcessInstance, ProcessProject } from "@leitwerk-dev/domain";
import {
	type BuiltServerProcessDefinition,
	type BuiltWorkerProcessDefinition,
	createServerProcessBuilder,
	createWorkerProcessBuilder,
	type ExtensionProcessDefinition,
	type LeitwerkExtensionModule,
	type LlmTurnDefinition,
	type ServerProcessContext,
	type TurnOptions,
	type TurnResult,
	type WorkerCompleteInput,
	type WorkerProcessContext,
	type WorkerTurnHandler,
} from "@leitwerk-dev/process-sdk";
import {
	buildExtensionCatalog,
	type ExtensionCatalog,
	type LoadedExtensionModule,
} from "./extension-loader.js";

/** @internal */
export interface TestExtensionModuleOptions {
	/** @internal */
	packageName?: string;
	/** @internal */
	packageDir?: string;
	/** @internal */
	entryPath?: string;
}

/** @internal */
export interface CreateTestProcessContextOptions<TParams = unknown, TState = unknown> {
	/** @internal */
	process?: ProcessInstance;
	/** @internal */
	projects?: readonly ProcessProject[];
	/** @internal */
	params?: TParams;
	/** @internal */
	state?: TState;
	/** @internal */
	workspaceRoot?: string;
	/** @internal */
	turnResultMarkdownBySemanticRef?: WorkerProcessContext<
		TParams,
		TState
	>["turnResultMarkdownBySemanticRef"];
	/** @internal */
	turnResultMarkdownByProduct?: WorkerProcessContext<
		TParams,
		TState
	>["turnResultMarkdownByProduct"];
}

/** @internal */
export interface CreateTestServerProcessContextOptions<TParams = unknown, TState = unknown>
	extends CreateTestProcessContextOptions<TParams, TState> {
	/** @internal */
	transition?: ServerProcessContext<TParams, TState>["transition"];
	/** @internal */
	emitEvent?: ServerProcessContext<TParams, TState>["emitEvent"];
	/** @internal */
	readSemanticTurnResultMarkdown?: ServerProcessContext<
		TParams,
		TState
	>["readSemanticTurnResultMarkdown"];
	/** @internal */
	readProductTurnResultMarkdown?: ServerProcessContext<
		TParams,
		TState
	>["readProductTurnResultMarkdown"];
	/** @internal */
	queueInput?: ServerProcessContext<TParams, TState>["queueInput"];
	/** @internal */
	applyLifecycleEffects?: ServerProcessContext<TParams, TState>["applyLifecycleEffects"];
}

/** @internal */
export interface WorkerTurnCall {
	/** @internal */
	turnId: string;
	/** @internal */
	options?: TurnOptions;
}

/** @internal */
export interface RunWorkerTurnForTestOptions<TParams = unknown, TState = unknown>
	extends CreateTestProcessContextOptions<TParams, TState> {
	/** @internal */
	turn?: (
		turnId: string,
		def: LlmTurnDefinition<string, TParams, TState>,
		options: TurnOptions | undefined,
		callIndex: number,
	) => Promise<TurnResult<string>> | TurnResult<string>;
	/** @internal */
	turnResults?: readonly TurnResult<string>[];
}

/** @internal */
export interface RunWorkerTurnForTestResult {
	/** @internal */
	turnCalls: readonly WorkerTurnCall[];
	/** @internal */
	completed: readonly WorkerCompleteInput<string>[];
	/** @internal */
	parkReasons: readonly (string | undefined)[];
}

/** @internal */
export function createLoadedExtensionModuleForTest(
	module: LeitwerkExtensionModule,
	options: TestExtensionModuleOptions = {},
): LoadedExtensionModule {
	const packageName = options.packageName ?? `test-${module.manifest.id}`;
	return {
		packageName,
		packageDir: options.packageDir ?? packageName,
		entryPath: options.entryPath ?? `${packageName}/index.ts`,
		module,
	};
}

/** @public */
export async function buildExtensionCatalogFromModules(
	modules: readonly LeitwerkExtensionModule[],
): Promise<ExtensionCatalog> {
	return buildExtensionCatalog(modules.map((module) => createLoadedExtensionModuleForTest(module)));
}

/** @internal */
export function createTestProcessInstance(
	overrides: Partial<ProcessInstance> = {},
): ProcessInstance {
	const processId = overrides.processId ?? "ticket_issue_process";
	const selectedTurnId =
		overrides.selectedTurnId !== undefined
			? overrides.selectedTurnId
			: processId === "ticket_issue_process"
				? "generate_plan"
				: null;
	const lifecycleStatus =
		overrides.lifecycleStatus ?? (selectedTurnId === null ? "discovered" : "active");
	return {
		id: "agt_test",
		currentExecution: null,
		planRevision: 0,
		title: null,
		externalId: null,
		externalUrl: null,
		metadata: null,
		defaultModelProfileId: null,
		turnConfigsJson: null,
		selectedTurnModelProfileId: null,
		paramsJson: null,
		stateJson: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
		processId,
		selectedTurnId,
		lifecycleStatus,
	};
}

/** @internal */
export function createTestProcessProject(overrides: Partial<ProcessProject> = {}): ProcessProject {
	return {
		id: "prj_test",
		instanceId: overrides.instanceId ?? "agt_test",
		key: "component-a",
		repoLocator: "https://example.invalid/component-a.git",
		repoLocatorKind: "remote_url",
		baseBranch: "main",
		workBranch: null,
		externalId: null,
		externalUrl: null,
		metadata: null,
		pipelineStatus: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

/** @internal */
export function createTestServerProcessContext<TParams = unknown, TState = unknown>(
	options: CreateTestServerProcessContextOptions<TParams, TState> = {},
): ServerProcessContext<TParams, TState> {
	return {
		process: options.process ?? createTestProcessInstance(),
		projects: [...(options.projects ?? [])],
		params: options.params as TParams,
		state: options.state as TState,
		transition: options.transition ?? (async () => {}),
		emitEvent: options.emitEvent ?? (() => {}),
		readSemanticTurnResultMarkdown: options.readSemanticTurnResultMarkdown ?? (() => null),
		readProductTurnResultMarkdown: options.readProductTurnResultMarkdown ?? (() => null),
		queueInput: options.queueInput ?? (() => {}),
		applyLifecycleEffects: options.applyLifecycleEffects,
	};
}

/** @internal */
export function createTestWorkerProcessContext<TParams = unknown, TState = unknown>(
	options: CreateTestProcessContextOptions<TParams, TState> = {},
): WorkerProcessContext<TParams, TState> {
	return {
		process: options.process ?? createTestProcessInstance(),
		projects: [...(options.projects ?? [])],
		params: options.params as TParams,
		state: options.state as TState,
		turnResultMarkdownBySemanticRef: options.turnResultMarkdownBySemanticRef,
		turnResultMarkdownByProduct: options.turnResultMarkdownByProduct,
		workspaceRoot: options.workspaceRoot,
	};
}

/** @internal */
export function buildWorkerProcessForTest<TParams = unknown, TState = unknown>(
	process: ExtensionProcessDefinition<TParams, TState>,
): BuiltWorkerProcessDefinition<TParams, TState> | undefined {
	if (!process.worker) {
		return undefined;
	}
	const builder = createWorkerProcessBuilder<TParams, TState>();
	process.worker(builder);
	return builder.getDefinition();
}

/** @internal */
export function buildServerProcessForTest<TParams = unknown, TState = unknown>(
	process: ExtensionProcessDefinition<TParams, TState>,
): BuiltServerProcessDefinition<TParams, TState> | undefined {
	if (!process.server) {
		return undefined;
	}
	const builder = createServerProcessBuilder<TParams, TState>();
	process.server(builder);
	return builder.getDefinition();
}

export {
	buildProcessLaunchers as buildProcessLaunchersForTest,
	buildProcessWatchers as buildProcessWatchersForTest,
} from "@leitwerk-dev/process-sdk";

/** @internal */
export async function runWorkerTurnForTest<TParams = unknown, TState = unknown>(
	handler: WorkerTurnHandler<TParams, TState>,
	options: RunWorkerTurnForTestOptions<TParams, TState> = {},
): Promise<RunWorkerTurnForTestResult> {
	const turnCalls: WorkerTurnCall[] = [];
	const completed: WorkerCompleteInput<string>[] = [];
	const parkReasons: (string | undefined)[] = [];
	const scriptedResults = [...(options.turnResults ?? [])];
	const ctx = createTestWorkerProcessContext(options);

	await handler({
		ctx,
		async turn<TOutcome extends string>(
			def: LlmTurnDefinition<TOutcome, TParams, TState>,
			turnOptions?: TurnOptions,
		) {
			const turnId = ctx.process.selectedTurnId ?? "unknown_turn";
			turnCalls.push({ turnId, options: turnOptions });
			const callIndex = turnCalls.length - 1;
			const result = options.turn
				? await options.turn(
						turnId,
						def as LlmTurnDefinition<string, TParams, TState>,
						turnOptions,
						callIndex,
					)
				: scriptedResults.shift();
			if (!result) {
				throw new Error(`No scripted turn result available for turn '${turnId}'`);
			}
			return result as TurnResult<TOutcome>;
		},
		async complete<TOutcome extends string>(input: WorkerCompleteInput<TOutcome>) {
			completed.push({
				outcome: input.outcome,
				params: input.params ?? {},
				markdown: input.markdown ?? null,
			});
		},
		park(reason?: string) {
			parkReasons.push(reason);
		},
	});

	return {
		turnCalls,
		completed,
		parkReasons,
	};
}
