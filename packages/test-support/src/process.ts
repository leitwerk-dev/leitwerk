import { bindExternalWrites } from "@leitwerk-dev/external-writes/internal";
import type { ExtensionTestCapability } from "./test-capability.js";

export type { ExtensionTestCapability } from "./test-capability.js";

import type {
	Actor,
	ProcessProject,
	ProcessTurnRecord,
	TurnProgressReport,
} from "@leitwerk-dev/domain";
import { setupServerExtensions } from "@leitwerk-dev/extension-runtime";
import {
	buildExtensionCatalogFromModules,
	buildServerProcessForTest,
	buildWorkerProcessForTest,
	createTestServerProcessContext,
} from "@leitwerk-dev/extension-runtime/testing";
import {
	buildProcessLaunchers,
	buildProcessWatchers,
	coreHostCapabilities,
	createCapabilityAccessor,
	type ExtensionProcessDefinition,
	type FormDefinition,
	type IntegrationToolDefinition,
	type LeitwerkExtensionModule,
	type ProcessLifecycleEffects,
	resolveHumanTurnView,
	type ServerProcessContext,
	type TicketCreationDestinationSnapshot,
	toProcessGraphView,
} from "@leitwerk-dev/process-sdk";
import { observe, type TestObservation } from "./observations.js";
import { createProcessFixture, type ProcessFixtureOptions } from "./process-fixtures.js";
import { createTestServerSetupCapability } from "./server-extension-test-harness.js";

export type { TestObservation } from "./observations.js";

/** Data-only process descriptions. @public */
export interface ExtensionProcessDescription {
	/** @public */
	id: string;
	/** @public */
	entryTurnId: string;
	/** @public */
	entryTurnIds: string[];
	/** @public */
	turns: {
		/** @public */
		id: string;
		/** @public */
		kind: string;
		/** @public */
		description: string;
		/** @public */
		availableTools?: readonly string[];
		/** @public */
		branchType?: string;
		/** @public */
		context?: string;
		/** @public */
		restorePrimaryLeafAfterTurn?: boolean;
		/** Human action descriptions, including scheduling and acceptance. @public */
		humanView?: {
			/** @public */
			actions: readonly {
				/** @public */
				actionId: string;
				/** @public */
				acceptanceState: string;
				/** @public */
				label?: string;
				/** @public */
				description?: string;
				/** @public */
				scheduling?: {
					/** @public */
					preview: {
						/** @public */
						kind: string;
						/** @public */
						trigger?: string;
						/** @public */
						turnId?: string | null;
						/** @public */
						lifecycleStatus?: string;
					};
				};
			}[];
		};
		/** @public */
		startFrom?: unknown;
		/** @public */
		publishedProduct?: string;
		/** @public */
		consumedProducts?: readonly string[];
	}[];
	/** @public */
	transitions: {
		/** @public */
		from: string;
		/** @public */
		nextTurnId?: string;
		/** @public */
		lifecycleStatus?: string;
		/** @public */
		outcome?: string;
		/** @public */
		trigger?: string;
	}[];
	/** @public */
	actions: {
		/** @public */
		id: string;
		/** @public */
		label: string;
		/** @public */
		form?: FormDefinition;
	}[];
	/** @public */
	launchers: {
		/** @public */
		id: string;
		/** @public */
		label: string;
		/** @public */
		description: string;
		/** @public */
		launchConfigSchema: FormDefinition;
	}[];
	/** @public */
	watchers: {
		/** @public */
		id: string;
		/** @public */
		label: string;
		/** @public */
		description: string;
		/** @public */
		source: string;
	}[];
}

/** Independent business data for each evaluation. @public */
export interface ExtensionToolFixture extends ExtensionProcessFixture {
	/** Reuse an invocation identity when retrying the same external write. @public */
	invocationId?: string;
	/** Authorized ticket destination resolved by the owning extension. @public */
	ticketDestination?: TicketCreationDestinationSnapshot;
}

/** Receipt recorded by an extension-owned external write. @public */
export interface ExtensionTestWriteReceipt {
	/** @public */
	instanceId: string;
	/** @public */
	writeType: string;
	/** @public */
	dedupKey: string;
	/** @public */
	metadata?: unknown;
}

/** Independent business data for each evaluation. @public */
export interface ExtensionProcessFixture<TParams = unknown, TState = unknown>
	extends ProcessFixtureOptions<TParams, TState> {
	/** @public */

	projects?: readonly ProcessProject[];
	/** Named product markdown available to prompts and effects. @public */
	products?: Readonly<Record<string, string>>;
	/** Workspace for process-owned file operations. @public */
	workspaceRoot?: string;
}

/** Scripted result of one LLM invocation. @public */
export interface ExtensionTurnResponse {
	/** @public */

	outcome: string;

	/** @public */

	params?: Record<string, unknown>;

	/** @public */

	markdown?: string | null;
	/** @public */
	resultSummary?: string;
}

/** Observable effects of process-owned server behavior. @public */
export interface ExtensionProcessEffects<TState = unknown> {
	/** @public */

	transitions: {
		/** @public */
		turnId?: string | null;

		/** @public */

		lifecycleStatus?: string;

		/** @public */

		state?: TState;

		/** @public */

		trigger?: string;
	}[];

	/** @public */

	inputs: {
		/** @public */
		source: string;

		/** @public */

		kind: string;

		/** @public */

		bodyMarkdown: string;

		/** @public */

		target?: unknown;
	}[];

	/** @public */

	events: {
		/** @public */
		type: string;

		/** @public */
		data: unknown;
	}[];

	/** @public */

	lifecycle: ProcessLifecycleEffects[];
}

/** Extension registration inputs; adapters remain owned by their extensions. @public */
export interface ExtensionTestHarnessOptions {
	/** Configuration keyed by extension manifest id. @public */
	extensionConfig?: Readonly<Record<string, unknown>>;
	/** @public */

	extensions?: readonly LeitwerkExtensionModule[];

	/** @public */

	capabilities?: readonly ExtensionTestCapability[];
}

/** Evaluate registered behavior without a database or worker. @public */
export async function createExtensionTestHarness(options: ExtensionTestHarnessOptions = {}) {
	const catalog = await buildExtensionCatalogFromModules(options.extensions ?? []);
	const receipts: ExtensionTestWriteReceipt[] = [];
	const externalWrites = {
		hasDedupKey: (key: string) => receipts.some((receipt) => receipt.dedupKey === key),
		record(input: ExtensionTestWriteReceipt) {
			const receipt = structuredClone(input);
			receipts.push(receipt);
			return receipt;
		},
	};
	const capabilities = createCapabilityAccessor([
		{
			token: coreHostCapabilities.serverSetup,
			value: createTestServerSetupCapability({ externalWrites }),
		},
		...(options.capabilities ?? []),
	]);
	const tools = new Map<string, IntegrationToolDefinition<unknown>>();
	const starts: (() => void | Promise<void>)[] = [];
	const stops: (() => void | Promise<void>)[] = [];
	const listeners = new Map<string, Set<(event: never) => void | Promise<void>>>();
	const pendingEvents = new Set<Promise<void>>();
	const eventErrors: unknown[] = [];
	let toolSequence = 0;
	function emit(type: string, event: unknown) {
		for (const listener of listeners.get(type) ?? []) {
			const task = Promise.resolve()
				.then(() => listener(structuredClone(event) as never))
				.catch((error) => {
					eventErrors.push(error);
				})
				.finally(() => pendingEvents.delete(task));
			pendingEvents.add(task);
		}
	}
	async function drainEvents() {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				(async () => {
					while (pendingEvents.size) await Promise.all([...pendingEvents]);
				})(),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(
						() => reject(new Error("Extension event handlers did not settle within 12 seconds")),
						12000,
					);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
		if (eventErrors.length)
			throw new AggregateError(eventErrors.splice(0), "Extension event handler failed");
	}
	let closed = false;
	function assertOpen() {
		if (closed) throw new Error("Extension test harness is closed");
	}
	/** @public */
	async function close() {
		if (closed) return;
		closed = true;
		const failures: unknown[] = [];
		for (const stop of stops.reverse()) {
			try {
				await stop();
			} catch (error) {
				failures.push(error);
			}
		}
		listeners.clear();
		try {
			await drainEvents();
		} catch (error) {
			failures.push(error);
		}
		if (failures.length) throw new AggregateError(failures, "Extension cleanup failed");
	}
	try {
		await setupServerExtensions(
			catalog,
			{
				provide: capabilities.provide.bind(capabilities),
				get: capabilities.get.bind(capabilities),
				require: capabilities.require.bind(capabilities),
				tool(tool) {
					if (tools.has(tool.name)) throw new Error(`Duplicate integration tool '${tool.name}'`);
					tools.set(tool.name, tool as IntegrationToolDefinition<unknown>);
				},
				events: {
					on(type, listener) {
						const set = listeners.get(type) ?? new Set();
						set.add(listener);
						listeners.set(type, set);
					},
					off(type, listener) {
						listeners.get(type)?.delete(listener);
					},
					emit,
				},
				onStart: (hook) => {
					starts.push(hook);
				},
				onStop: (hook) => {
					stops.push(hook);
				},
			},
			(id) => structuredClone(options.extensionConfig?.[id] ?? {}),
		);
		for (const start of starts) await start();
		await drainEvents();
	} catch (error) {
		await close().catch(() => {});
		throw error;
	}

	/** @public */
	async function callTool(
		name: string,
		args: Record<string, unknown>,
		fixture: ExtensionToolFixture = {},
	) {
		assertOpen();
		const tool = tools.get(name);
		if (!tool) throw new Error(`Unknown integration tool '${name}'`);
		const process = createProcessFixture(fixture);
		const projects = structuredClone([...(fixture.projects ?? [])]);
		for (const project of projects)
			if (project.instanceId !== process.id) throw new Error("Project belongs to another process");
		const turn: ProcessTurnRecord = {
			id: "trn_test",
			instanceId: process.id,
			turnId: process.selectedTurnId ?? "test_turn",
			turnType: "automatic",
			status: "running",
			attemptNumber: 1,
			parentTurnRecordId: null,
			pathType: "primary",
			forkPiEntryId: null,
			resultPiEntryId: null,
			modelProfileId: null,
			turnResultMarkdown: null,
			errorSummary: null,
			errorClass: null,
			startedAt: process.createdAt,
			endedAt: null,
		};
		return observe(
			await tool.execute(
				{
					process,
					projects,
					turn,
					project:
						projects.find((project) => project.key === args.projectKey) ??
						(projects.length === 1 ? (projects[0] ?? null) : null),
					idempotencyKey: fixture.invocationId ?? `${process.id}:test_tool:${++toolSequence}`,
					ticketDestination: structuredClone(fixture.ticketDestination),
					externalWrites: bindExternalWrites(externalWrites, process.id),
					signal: new AbortController().signal,
				},
				tool.parse ? tool.parse(structuredClone(args)) : structuredClone(args),
			),
		);
	}

	function destinationProvider(name: string) {
		assertOpen();
		const provider = tools.get(name)?.capability?.destinations;
		if (!provider) throw new Error(`Tool '${name}' has no ticket destinations`);
		return provider;
	}
	return {
		/** List destinations through the registered tool capability. @public */
		async listToolDestinations(name: string, actor: Actor) {
			return observe(await destinationProvider(name).list({ actor: structuredClone(actor) }));
		},
		/** Resolve an authorized destination snapshot. @public */
		async resolveToolDestination(name: string, destinationId: string, actor: Actor) {
			return observe(
				await destinationProvider(name).resolve({ actor: structuredClone(actor), destinationId }),
			);
		},
		/** Validate a saved destination against the provider. @public */
		async validateToolDestination(name: string, snapshot: TicketCreationDestinationSnapshot) {
			await destinationProvider(name).validate(structuredClone(snapshot));
		},
		/** Detached descriptions of registered tools. @public */
		describeTools() {
			assertOpen();
			return observe(
				[...tools.values()].map(({ name, description, parameters }) => ({
					/** @public */
					name,
					/** @public */
					description,
					/** @public */
					parameters,
				})),
			);
		},
		/** Detached receipts, including writes recorded before an invocation failed. @public */
		writeReceipts() {
			assertOpen();
			return observe(receipts);
		},
		/** Run an integration tool registered by an extension. @public */
		callTool,
		/** Deliver an event and await its registered handlers. @public */
		async emit(type: string, event: unknown) {
			assertOpen();
			emit(type, event);
			await drainEvents();
		},
		/** Run cleanup hooks once, including when another hook fails. @public */
		close,
		/** Bind a definition and independent default fixtures. @public */
		process<TParams, TState>(
			definition: ExtensionProcessDefinition<TParams, TState>,
			initial: ExtensionProcessFixture<TParams, TState> = {},
		) {
			assertOpen();
			const defaults = structuredClone(initial);
			const worker = buildWorkerProcessForTest(definition);
			const server = buildServerProcessForTest(definition);
			const launchers = buildProcessLaunchers(definition)?.launchers;
			const watchers = buildProcessWatchers(definition)?.watchers;
			function context(fixture: ExtensionProcessFixture<TParams, TState> = {}) {
				assertOpen();
				const input = structuredClone({ ...defaults, ...fixture });
				const process = createProcessFixture(input, definition);
				const projects = input.projects ?? [];
				for (const project of projects)
					if (project.instanceId !== process.id)
						throw new Error("Project belongs to another process");
				return {
					process,
					projects,
					params: definition.paramsCodec.parse(JSON.parse(process.paramsJson ?? "null")),
					state: definition.stateCodec.parse(JSON.parse(process.stateJson ?? "null")),
					turnResultMarkdownByProduct: input.products,
					workspaceRoot: input.workspaceRoot,
				};
			}
			function effects(fixture?: ExtensionProcessFixture<TParams, TState>) {
				const base = context(fixture);
				const result: ExtensionProcessEffects<TState> = {
					transitions: [],
					inputs: [],
					events: [],
					lifecycle: [],
				};
				const ctx = createTestServerProcessContext({
					...base,
					transition: async (next) => {
						result.transitions.push(structuredClone(next));
					},
					queueInput: (input) => {
						result.inputs.push(structuredClone(input));
					},
					emitEvent: (type, data) => {
						result.events.push({ type, data: structuredClone(data) });
					},
					applyLifecycleEffects: (effect) => {
						result.lifecycle.push(structuredClone(effect));
					},
					readProductTurnResultMarkdown: (name) => base.turnResultMarkdownByProduct?.[name] ?? null,
					readSemanticTurnResultMarkdown: (name) =>
						base.turnResultMarkdownByProduct?.[name] ?? null,
				});
				return { ctx, result };
			}
			context();
			return {
				/** Return data descriptions without exposing registered handlers. @public */
				describe(): TestObservation<ExtensionProcessDescription> {
					assertOpen();
					return observe({
						/** @public */
						id: definition.id,
						/** @public */
						entryTurnId: definition.entryTurnId,
						entryTurnIds: [definition.entryTurnId, ...(definition.alternateEntryTurnIds ?? [])],
						/** @public */
						turns: [...definition.turns].map(([id, binding]) => ({
							id,
							kind: binding.definition.kind,
							description: binding.definition.description,
							...(binding.definition.kind === "llm"
								? {
										availableTools: binding.definition.availableTools,
										branchType: binding.definition.branchType,
										context: binding.definition.context,
										restorePrimaryLeafAfterTurn: binding.definition.restorePrimaryLeafAfterTurn,
										startFrom: binding.definition.startFrom,
										publishedProduct: binding.definition.publishedProduct,
										consumedProducts: binding.definition.consumedProducts,
									}
								: binding.definition.kind === "human"
									? { humanView: resolveHumanTurnView({ turnId: id, turn: binding.definition }) }
									: {}),
						})),
						/** @public */
						transitions: [
							...toProcessGraphView(definition as ExtensionProcessDefinition).turns,
						].flatMap(([from, turn]) =>
							turn.transitions.map((transition) => ({ from, ...transition })),
						),
						/** @public */
						actions: [...(server?.actions.values() ?? [])].map((a) => ({
							/** @public */
							id: a.id,
							label: a.label,
							form: a.form,
						})),
						/** @public */
						launchers: [...(launchers?.values() ?? [])].map((a) => ({
							/** @public */
							id: a.id,
							label: a.label,
							description: a.description,
							launchConfigSchema: a.ui.launchConfigSchema as FormDefinition,
						})),
						/** @public */
						watchers: [...(watchers?.values() ?? [])].map((a) => ({
							/** @public */
							id: a.id,
							label: a.label,
							description: a.description,
							source: a.source.id,
						})),
					});
				},
				/** Resolve a UI launcher using its own validation. @public */
				async resolveLaunch(id: string, input: Record<string, unknown>) {
					const ctx = context();
					const launcher = launchers?.get(id);
					if (!launcher) throw new Error(`Unknown launcher '${id}'`);
					return observe(await launcher.ui.resolveLaunchConfig(structuredClone(input), ctx));
				},
				/** Prepare persisted launcher input for a new launch. @public */
				async prepareRelaunch(id: string, previousInput: Record<string, unknown>) {
					const ctx = context();
					const launcher = launchers?.get(id);
					if (!launcher) throw new Error(`Unknown launcher '${id}'`);
					return observe(
						(await launcher.ui.resolveRelaunchInput?.(structuredClone(previousInput), ctx)) ??
							previousInput,
					);
				},
				/** Parse source configuration and resolve a matching watcher event. @public */
				async resolveWatcherLaunch(id: string, event: unknown, config: unknown) {
					const ctx = context();
					const watcher = watchers?.get(id);
					if (!watcher) throw new Error(`Unknown watcher '${id}'`);
					const parsed = watcher.source.parseConfig(structuredClone(config));
					if (
						!parsed.enabled ||
						(watcher.matches && !(await watcher.matches(structuredClone(event), ctx)))
					)
						return null;
					return observe(await watcher.resolveLaunchConfig(structuredClone(event), ctx));
				},
				/** Run preparation, prompt evaluation, and the registered worker handler. @public */
				async evaluateTurn(
					id: string,
					options: {
						/** @public */
						responses?: readonly ExtensionTurnResponse[];

						/** @public */

						fixture?: ExtensionProcessFixture<TParams, TState>;
					} = {},
				) {
					const binding = definition.turns.get(id);
					const handler = worker?.turns.get(id);
					if (!binding || !handler) throw new Error(`Unknown worker turn '${id}'`);
					const base = context({
						...options.fixture,
						position: { selectedTurnId: id, lifecycleStatus: "active" },
					});
					const prompts: string[] = [];
					const tools: { name: string; arguments: Record<string, unknown> }[] = [];
					const progress: TurnProgressReport[] = [];
					const completed: ExtensionTurnResponse[] = [];
					const requestedTools = new Set<string>();
					const parked: (string | undefined)[] = [];
					const responses = structuredClone([...(options.responses ?? [])]);
					const ctx = {
						...base,
						async callIntegrationTool(name: string, args: Record<string, unknown>) {
							const def = binding.definition;
							const allowed =
								def.kind === "llm"
									? (def.resolveIntegrationTools?.(base.params, base.state) ?? def.integrationTools)
									: def.kind === "automatic"
										? def.integrationTools
										: [];
							if (!allowed?.includes(name))
								throw new Error(`Integration tool '${name}' is not declared for '${id}'`);
							tools.push({ name, arguments: structuredClone(args) });
							return callTool(name, args, {
								...defaults,
								...options.fixture,
								processId: definition.id,
								params: base.params,
								state: base.state,
								position: { selectedTurnId: id, lifecycleStatus: "active" },
							});
						},
						reportProgress: (report: TurnProgressReport) => {
							progress.push(structuredClone(report));
						},
					};
					await handler({
						ctx,
						async turn(def) {
							for (const name of [
								...def.availableTools,
								...Object.keys(def.outcomes ?? {}),
								...(def.resolveIntegrationTools?.(base.params, base.state) ??
									def.integrationTools ??
									[]),
								...(def.askQuestions ? ["ask_questions"] : []),
							])
								requestedTools.add(name);
							const prepared = await def.prepare?.({
								...ctx,
								callIntegrationTool: ctx.callIntegrationTool,
								reportProgress: ctx.reportProgress,
							});
							prompts.push(await def.prompt({ ...ctx, prepared }));
							const response = responses.shift();
							if (!response)
								throw new Error(
									`Script exhausted while evaluating '${definition.id}/${id}' after ${prompts.length} prompt(s)`,
								);
							if (
								def.turnEnd?.outcome !== response.outcome &&
								!Object.hasOwn(def.outcomes ?? {}, response.outcome)
							)
								throw new Error(`Undeclared outcome '${response.outcome}' for '${id}'`);
							completed.push(response);
							return { outcome: response.outcome as never, params: response.params ?? {} };
						},
						async complete(input) {
							completed.push(structuredClone(input));
						},
						park(reason) {
							parked.push(reason);
						},
					});
					return observe({
						prompts,
						tools,
						requestedTools: [...requestedTools],
						progress,
						completed,
						parked,
					});
				},
				/** Evaluate a process action and collect its requested effects. @public */
				async evaluateAction(
					id: string,
					input: Record<string, unknown> = {},
					fixture?: ExtensionProcessFixture<TParams, TState>,
				): Promise<TestObservation<ExtensionProcessEffects<TState>>> {
					const action = server?.actions.get(id);
					if (!action) throw new Error(`Unknown action '${id}'`);
					const { ctx, result } = effects(fixture);
					await action.plan?.(structuredClone(input), ctx);
					await action.execute?.(structuredClone(input), ctx);
					return observe(result);
				},
				/** Evaluate process-owned outcome handling against fresh business data. @public */
				async evaluateOutcome(
					id: string,
					outcome: ExtensionTurnResponse,
					fixture?: ExtensionProcessFixture<TParams, TState>,
				): Promise<TestObservation<ExtensionProcessEffects<TState>>> {
					if (!definition.turns.has(id)) throw new Error(`Undeclared turn '${id}'`);
					const { ctx, result } = effects({
						...fixture,
						position: fixture?.position ??
							defaults.position ?? { selectedTurnId: id, lifecycleStatus: "active" },
					});
					for (const handler of server?.turnOutcomeHandlers.get(id) ?? [])
						await handler(
							{
								turnId: id,
								turnRecordId: "trn_test",
								outcome: outcome.outcome,
								params: structuredClone(outcome.params ?? {}),
								turnResultMarkdown: outcome.markdown,
							},
							ctx as ServerProcessContext<TParams, TState>,
						);
					return observe(result);
				},
			};
		},
	};
}
