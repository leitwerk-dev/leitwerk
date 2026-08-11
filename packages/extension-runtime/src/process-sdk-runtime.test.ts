import type {
	ExtensionProcessDefinition,
	LeitwerkExtensionModule,
} from "@leitwerk-dev/process-sdk";
import {
	createCapabilityAccessor,
	createEventBus,
	createProcessLauncherBuilder,
	createProcessWatcherBuilder,
	createServerProcessBuilder,
	createUiProcessBuilder,
	createWorkerProcessBuilder,
	defineProcess,
	defineProcessWatcherSource,
	getProcessGraph,
	humanTurn,
	llmTurn,
	MARKDOWN_RESULT_TOOL_NAME,
	validateLeafOutcomeCaptureResult,
} from "@leitwerk-dev/process-sdk";
import { markDefinedProcess } from "@leitwerk-dev/process-sdk/runtime-internals";
import { describe, expect, it, vi } from "vitest";
import {
	buildWorkerRuntimeDefinition,
	createCatalogWorkerDefinitionResolver,
	setupServerExtensions,
	setupWorkerExtensions,
} from "./index.js";
import {
	buildExtensionCatalogFromModules,
	buildProcessLaunchersForTest,
	createTestProcessInstance,
	runWorkerTurnForTest,
} from "./testing.js";

describe("createEventBus", () => {
	it("delivers emitted data to subscribed handlers", () => {
		const bus = createEventBus();
		const handler = vi.fn();
		bus.on("e", handler);

		bus.emit("e", { x: 1 });

		expect(handler).toHaveBeenCalledWith({ x: 1 });
	});

	it("does not invoke handlers after off", () => {
		const bus = createEventBus();
		const handler = vi.fn();
		bus.on("e", handler);
		bus.off("e", handler);

		bus.emit("e", {});

		expect(handler).not.toHaveBeenCalled();
	});

	it("continues notifying other handlers when one throws", () => {
		const bus = createEventBus();
		const bad = vi.fn(() => {
			throw new Error("boom");
		});
		const good = vi.fn();
		bus.on("e", bad);
		bus.on("e", good);

		expect(() => bus.emit("e", null)).not.toThrow();
		expect(good).toHaveBeenCalledWith(null);
	});
});

const testWatcherSource = defineProcessWatcherSource<Record<string, never>>({
	id: "test_source",
	label: "Test source",
	parseConfig: () => ({ config: {}, enabled: true }),
	presentConfig: () => ({ targetSummary: "Test target" }),
});

describe("createWorkerProcessBuilder", () => {
	it("records the start node and registered nodes", () => {
		const proc = createWorkerProcessBuilder<{ mode: string }, { attempts: number }>();
		const handler = vi.fn();
		proc.start("entry_turn");
		proc.turn("entry_turn", handler);

		const definition = proc.getDefinition();
		expect(definition.startTurnId).toBe("entry_turn");
		expect(definition.turns.get("entry_turn")).toBe(handler);
	});

	it("rejects duplicate node ids", () => {
		const proc = createWorkerProcessBuilder();
		proc.turn("entry_turn", async () => {});

		expect(() => proc.turn("entry_turn", async () => {})).toThrow(/already registered/);
	});
});

describe("buildWorkerRuntimeDefinition", () => {
	const process = defineProcess<{ flag: boolean }, { attempts: number }>({
		id: "test_process",
		displayName: "Test Process",
		entry: "entry_turn",
		piConfig: {
			systemPromptTemplate: "You are working with {{flag}}",
		},
		paramsCodec: {
			parse: (value: unknown) => ({
				flag:
					typeof value === "object" && value !== null && "flag" in value
						? Boolean(value.flag)
						: true,
			}),
			serialize: (value: { flag: boolean }) => value,
		},
		stateCodec: {
			parse: (value: unknown) => ({
				attempts:
					typeof value === "object" && value !== null && "attempts" in value
						? Number(value.attempts)
						: 0,
			}),
			serialize: (value: { attempts: number }) => value,
		},
		initialState: (params: { flag: boolean }) => ({ attempts: params.flag ? 1 : 0 }),
		turns: {
			entry_turn: llmTurn({
				availableTools: [],
				description: "Entry",
				branchType: "primary",
				context: "fresh",
				prompt: async () => "entry",
				turnEnd: { outcome: "done", params: {}, complete: true },
			}),
		},
	});

	it("builds a resolved worker process with parsed params and state", () => {
		const runtime = buildWorkerRuntimeDefinition(process, {
			paramsJson: JSON.stringify({ flag: false }),
			stateJson: JSON.stringify({ attempts: 7 }),
		});

		expect(runtime).toMatchObject({
			processId: "test_process",
			startTurnId: "entry_turn",
			params: { flag: false },
			state: { attempts: 7 },
			piConfig: {
				systemPromptTemplate: "You are working with {{flag}}",
			},
		});
		expect(runtime?.definition.turns.has("entry_turn")).toBe(true);
	});

	it("falls back to codec/default-derived params and initial state", () => {
		const runtime = buildWorkerRuntimeDefinition(process);

		expect(runtime).toMatchObject({
			params: { flag: true },
			state: { attempts: 1 },
		});
	});

	it("returns undefined when the process has no worker definition", () => {
		const runtime = buildWorkerRuntimeDefinition({
			...process,
			worker: undefined,
		});

		expect(runtime).toBeUndefined();
	});

	it("allows outcome tools without graph targets to stay on the current turn", () => {
		const stayProcess = defineProcess<Record<string, never>, Record<string, never>>({
			id: "stay_process",
			displayName: "Stay Process",
			entry: "inspect",
			paramsCodec: { parse: () => ({}), serialize: (value) => value },
			stateCodec: { parse: () => ({}), serialize: (value) => value },
			initialState: () => ({}),
			turns: {
				inspect: llmTurn({
					availableTools: [],
					description: "Inspect",
					branchType: "primary",
					context: "fresh",
					prompt: async () => "inspect",
					outcomes: {
						parked: { description: "Park", parameters: {} },
					},
				}),
			},
		});

		expect(
			getProcessGraph(new Map([[stayProcess.id, stayProcess]]), stayProcess.id).turns.get("inspect")
				?.transitions,
		).toEqual([{ nextTurnId: "inspect", outcome: "parked" }]);
	});

	it("returns undefined when the worker definition has no start node", () => {
		const runtime = buildWorkerRuntimeDefinition({
			...process,
			worker(proc) {
				proc.turn("entry_turn", async () => {});
			},
		});

		expect(runtime).toBeUndefined();
	});
});

describe("createCatalogWorkerDefinitionResolver", () => {
	it("resolves worker processes from the catalog by process id", async () => {
		const process = defineProcess<Record<string, never>, { count: number }>({
			id: "catalog_test",
			displayName: "Catalog Test",
			entry: "entry_turn",
			paramsCodec: { parse: () => ({}), serialize: (value: Record<string, never>) => value },
			stateCodec: { parse: () => ({ count: 0 }), serialize: (value: { count: number }) => value },
			initialState: () => ({ count: 0 }),
			turns: {
				entry_turn: llmTurn({
					availableTools: [],
					description: "Entry",
					branchType: "primary",
					context: "fresh",
					prompt: async () => "entry",
					turnEnd: { outcome: "done", params: {}, complete: true },
				}),
			},
		});
		const catalog = await buildExtensionCatalogFromModules([
			{
				manifest: { id: "catalog-test", version: "0.1.0" },
				setupCatalog(api) {
					api.registerProcess(process);
				},
			},
		]);

		const resolve = createCatalogWorkerDefinitionResolver(catalog);
		expect(resolve("catalog_test")?.processId).toBe("catalog_test");
		expect(resolve("missing")).toBeUndefined();
	});
});

describe("process builders", () => {
	it("collects server actions, turn outcome handlers, and cleanup hooks", () => {
		const builder = createServerProcessBuilder<{ mode: string }, { attempts: number }>();
		const outcomeHandler = vi.fn();
		const cleanupHandler = vi.fn();
		builder.action({
			id: "retry",
			label: "Retry",
			plan: async () => {},
		});
		builder.onTurnOutcome("run_llm_review", outcomeHandler);
		builder.onCleanup(cleanupHandler);

		const definition = builder.getDefinition();
		expect(definition.actions.get("retry")?.label).toBe("Retry");
		expect(definition.turnOutcomeHandlers.get("run_llm_review")).toEqual([outcomeHandler]);
		expect(definition.cleanupHandlers).toEqual([cleanupHandler]);
	});

	it("requires execute-only actions to opt into side-effect execution", () => {
		const builder = createServerProcessBuilder();

		expect(() =>
			builder.action({
				id: "send_notification",
				label: "Send notification",
				execute: async () => {},
			}),
		).toThrow(
			"Process action 'send_notification' with execute(...) must set executionMode: \"side_effect\"",
		);
	});

	it("collects explicit side-effect execute-only actions", () => {
		const builder = createServerProcessBuilder();
		builder.action({
			id: "send_notification",
			label: "Send notification",
			executionMode: "side_effect",
			execute: async () => {},
		});

		expect([...builder.getDefinition().actions.keys()]).toEqual(["send_notification"]);
	});

	it("rejects invalid action previews on server actions", () => {
		const builder = createServerProcessBuilder();

		expect(() =>
			builder.action({
				id: "retry",
				label: "Retry",
				preview: { kind: "fixed_turn", turnId: "   " },
				plan: async () => {},
			}),
		).toThrow(
			"Process action 'retry' preview must declare a non-empty fixed turn id when turnId is not null",
		);
	});

	it("rejects invalid scheduling previews on server actions", () => {
		const builder = createServerProcessBuilder();

		expect(() =>
			builder.action({
				id: "retry",
				label: "Retry",
				scheduling: { preview: { kind: "fixed_turn", turnId: "   " } },
				plan: async () => {},
			}),
		).toThrow(
			"Process action 'retry' scheduling must declare a non-empty fixed turn id when turnId is not null",
		);
	});

	it("collects a single leaf outcome definition", () => {
		const builder = createUiProcessBuilder();
		builder.leafOutcome({
			rendererId: "test:details.leaf_outcome",
			capture: () => ({
				rendererId: "test:details.leaf_outcome",
				props: { title: "Leaf" },
				fallbackMarkdown: "## Leaf",
			}),
		});

		const definition = builder.getDefinition();
		expect(definition.leafOutcome?.rendererId).toBe("test:details.leaf_outcome");
	});

	it("rejects duplicate or invalid leaf outcome definitions and validates capture results", () => {
		const builder = createUiProcessBuilder();
		builder.leafOutcome({
			rendererId: "test:process.leaf_outcome",
			capture: () => ({
				rendererId: "test:process.leaf_outcome",
				props: {},
			}),
		});

		expect(() =>
			builder.leafOutcome({
				rendererId: "test:other.leaf_outcome",
				capture: () => ({
					rendererId: "test:other.leaf_outcome",
					props: {},
				}),
			}),
		).toThrow("Leaf outcome is already registered");

		expect(() =>
			createUiProcessBuilder().leafOutcome({
				rendererId: "",
				capture: () => ({ rendererId: "", props: {} }),
			}),
		).toThrow("Leaf outcome definition must declare a non-empty rendererId");

		expect(validateLeafOutcomeCaptureResult({ rendererId: "test:ok", props: {} })).toEqual([]);
		expect(
			validateLeafOutcomeCaptureResult({ rendererId: "test:wrong", props: [] }, "test:expected"),
		).toEqual([
			"Leaf outcome capture result rendererId 'test:wrong' must match 'test:expected'",
			"Leaf outcome capture result props must be an object",
		]);
	});

	it("seeds the core markdown_result tool renderer and collects extension renderers", async () => {
		const extension: LeitwerkExtensionModule = {
			manifest: { id: "tool-renderer-test", version: "0.1.0" },
			setupCatalog(api) {
				api.registerToolRenderer({
					toolName: "publish_review",
					title: "Publish review",
					fields: [
						{
							id: "review",
							label: "Rendered review",
							kind: "markdown",
							source: "arguments",
							path: "reviewMarkdown",
						},
					],
				});
			},
		};

		const catalog = await buildExtensionCatalogFromModules([extension]);
		expect(catalog.toolRenderers.get(MARKDOWN_RESULT_TOOL_NAME)).toMatchObject({
			toolName: MARKDOWN_RESULT_TOOL_NAME,
		});
		expect(catalog.toolRenderers.get("publish_review")).toMatchObject({
			toolName: "publish_review",
		});
	});

	it("rejects invalid or duplicate tool renderers", async () => {
		await expect(
			buildExtensionCatalogFromModules([
				{
					manifest: { id: "tool-renderer-invalid", version: "0.1.0" },
					setupCatalog(api) {
						api.registerToolRenderer({
							toolName: "broken",
							fields: [],
						});
					},
				},
			]),
		).rejects.toThrow("must declare at least one field");

		await expect(
			buildExtensionCatalogFromModules([
				{
					manifest: { id: "tool-renderer-duplicate", version: "0.1.0" },
					setupCatalog(api) {
						api.registerToolRenderer({
							toolName: MARKDOWN_RESULT_TOOL_NAME,
							fields: [
								{
									id: "markdown",
									label: "Markdown",
									kind: "markdown",
									source: "arguments",
									path: "markdown",
								},
							],
						});
					},
				},
			]),
		).rejects.toThrow(`Tool renderer '${MARKDOWN_RESULT_TOOL_NAME}' is already registered`);
	});

	it("collects launcher definitions", () => {
		const builder = createProcessLauncherBuilder<{ repoPath: string }>();
		builder.launcher({
			id: "local_repo_ui",
			label: "Local Repo",
			description: "Run against a local repository",
			visibility: "ui",
			ui: {
				card: {},
				launchConfigSchema: {
					id: "local_repo_form",
					title: "Local Repo",
					fields: [{ id: "repoPath", label: "Repo", kind: "text", required: true }],
				},
				resolveLaunchConfig(input) {
					return {
						ok: true,
						launchConfig: {
							processId: "test_process",
							params: { repoPath: String(input.repoPath ?? "") },
						},
					};
				},
			},
		});

		const definition = builder.getDefinition();
		expect(definition.launchers.has("local_repo_ui")).toBe(true);
	});

	it("rejects non-UI launcher visibility", () => {
		const builder = createProcessLauncherBuilder();
		expect(() =>
			builder.launcher({
				id: "broken",
				label: "Broken",
				description: "Broken",
				visibility: "watcher" as "ui",
				ui: {
					card: {},
					launchConfigSchema: { id: "f", title: "F", fields: [] },
					resolveLaunchConfig: () => ({
						ok: true,
						launchConfig: { processId: "test_process", params: {} },
					}),
				},
			}),
		).toThrow(/unsupported visibility/);
	});

	it("rejects UI launchers without a ui block", () => {
		const builder = createProcessLauncherBuilder();
		expect(() =>
			builder.launcher({
				id: "broken_ui",
				label: "Broken UI",
				description: "Broken UI",
				visibility: "ui",
			} as never),
		).toThrow("UI launcher 'broken_ui' must define a ui block");
	});

	it("rejects duplicate launcher ids", () => {
		const builder = createProcessLauncherBuilder();
		const ui = {
			card: {},
			launchConfigSchema: { id: "f", title: "F", fields: [] },
			resolveLaunchConfig: () => ({
				ok: true as const,
				launchConfig: { processId: "test_process", params: {} },
			}),
		};
		builder.launcher({
			id: "duplicate",
			label: "First",
			description: "First",
			visibility: "ui",
			ui,
		});

		expect(() =>
			builder.launcher({
				id: "duplicate",
				label: "Second",
				description: "Second",
				visibility: "ui",
				ui,
			}),
		).toThrow(/already registered/);
	});

	it("builds process launchers from process definitions", () => {
		const process: ExtensionProcessDefinition<{ repoPath: string }, Record<string, never>> = {
			id: "test_process",
			displayName: "Test Process",
			entryTurnId: "launch",
			turns: new Map(),
			paramsCodec: {
				parse: () => ({ repoPath: "" }),
				serialize: (value: { repoPath: string }) => value,
			},
			stateCodec: {
				parse: () => ({}),
				serialize: (value: Record<string, never>) => value,
			},
			initialState: () => ({}),
			launchers(api) {
				api.launcher({
					id: "local_repo_ui",
					label: "Local Repo",
					description: "Run against a local repository",
					visibility: "ui",
					ui: {
						card: {},
						launchConfigSchema: { id: "f", title: "F", fields: [] },
						resolveLaunchConfig: () => ({
							ok: true,
							launchConfig: { processId: "test_process", params: { repoPath: "/tmp/p" } },
						}),
					},
				});
			},
		};

		const built = buildProcessLaunchersForTest(process);
		expect(built?.launchers.has("local_repo_ui")).toBe(true);
	});

	it("collects and validates process watchers", () => {
		const builder = createProcessWatcherBuilder<{ repoPath: string }>();
		builder.watcher({
			id: "fs_repo",
			label: "Filesystem Repo",
			description: "Launch from filesystem events",
			source: testWatcherSource,
			resolveLaunchConfig: () => ({
				processId: "test_process",
				params: { repoPath: "/tmp/repo" },
			}),
		});

		expect(builder.getDefinition().watchers.has("fs_repo")).toBe(true);
	});

	it("rejects duplicate process watcher ids", () => {
		const builder = createProcessWatcherBuilder();
		builder.watcher({
			id: "duplicate",
			label: "First",
			description: "First watcher",
			source: testWatcherSource,
			resolveLaunchConfig: () => ({ processId: "test_process", params: {} }),
		});

		expect(() =>
			builder.watcher({
				id: "duplicate",
				label: "Second",
				description: "Second watcher",
				source: testWatcherSource,
				resolveLaunchConfig: () => ({ processId: "test_process", params: {} }),
			}),
		).toThrow(/already registered/);
	});
});

describe("runWorkerTurnForTest", () => {
	it("runs worker turns without the worker host", async () => {
		const handler = vi.fn(async (run) => {
			await run.turn(
				llmTurn({
					availableTools: [],
					description: "Verify",
					completionMode: "turn_end",
					branchType: "primary",
					context: "full",
					prompt: async () => "verify",
					outcomes: {
						build_passing: {
							description: "passing",
							parameters: {},
						},
					},
				}),
			);
			run.park("manual_follow_up");
		});

		const result = await runWorkerTurnForTest(handler, {
			process: createTestProcessInstance({ selectedTurnId: "verify_build" }),
			turnResults: [{ outcome: "build_passing", params: {} }],
		});

		expect(result.turnCalls).toEqual([{ turnId: "verify_build", options: undefined }]);
		expect(result.completed).toEqual([]);
		expect(result.parkReasons).toEqual(["manual_follow_up"]);
	});

	it("records deterministic completions from worker handlers", async () => {
		const handler = vi.fn(async (run) => {
			await run.complete({
				outcome: "finalized",
				params: { headSha: "abc123" },
				markdown: "## Finalized\n\nDone.",
			});
		});

		const result = await runWorkerTurnForTest(handler);

		expect(result.turnCalls).toEqual([]);
		expect(result.completed).toEqual([
			{
				outcome: "finalized",
				params: { headSha: "abc123" },
				markdown: "## Finalized\n\nDone.",
			},
		]);
		expect(result.parkReasons).toEqual([]);
	});
});

describe("extension catalog test helpers", () => {
	it("builds a catalog directly from modules", async () => {
		const dependency: LeitwerkExtensionModule = {
			manifest: { id: "review", version: "0.1.0" },
			setupCatalog(api) {
				api.provide({ id: "cap:review", cardinality: "single" }, { name: "review" });
			},
		};
		const extension: LeitwerkExtensionModule = {
			manifest: { id: "implement", version: "0.1.0", requires: ["review"] },
			setupCatalog(api) {
				const capability = api.require<{ name: string }>({
					id: "cap:review",
					cardinality: "single",
				});
				api.registerProcess(
					defineProcess({
						id: "implement_process",
						displayName: "Implement",
						entry: "implement",
						paramsCodec: { parse: () => ({}), serialize: (value) => value },
						stateCodec: { parse: () => ({}), serialize: (value) => value },
						initialState: () => ({}),
						turns: {
							implement: llmTurn({
								availableTools: [],
								description: capability.name,
								branchType: "primary",
								context: "full",
								prompt: async () => "implement",
								turnEnd: { outcome: "done", params: {}, complete: true },
							}),
							plan_review: humanTurn({
								description: "Review the generated plan",
								reviewSubject: { kind: "plan" },
								actions: {
									approve_plan: {
										label: "Approve plan",
										acceptanceState: "accepted",
										complete: true,
									},
									request_revision: {
										label: "Request revision",
										acceptanceState: "requires_changes",
										to: "implement",
									},
								},
							}),
						},
					}),
				);
			},
		};

		const catalog = await buildExtensionCatalogFromModules([extension, dependency]);
		expect(catalog.modules.map((module) => module.module.manifest.id)).toEqual([
			"review",
			"implement",
		]);
		expect(
			catalog.processes.get("implement_process")?.turns.get("implement")?.definition.description,
		).toBe("review");
		expect(
			catalog.processes.get("implement_process")?.turns.get("plan_review")?.definition.kind,
		).toBe("human");
	});

	it("rejects processes whose entry turn is not declared", async () => {
		const valid = defineProcess({
			id: "invalid_entry_turn_process",
			displayName: "Invalid Entry Turn",
			entry: "real_turn",
			paramsCodec: { parse: () => ({}), serialize: (value) => value },
			stateCodec: { parse: () => ({}), serialize: (value) => value },
			initialState: () => ({}),
			turns: {
				real_turn: llmTurn({
					availableTools: [],
					description: "Real turn",
					branchType: "primary",
					context: "fresh",
					prompt: async () => "real",
					turnEnd: { outcome: "done", params: {}, complete: true },
				}),
			},
		});
		const extension: LeitwerkExtensionModule = {
			manifest: { id: "invalid-entry-turn", version: "0.1.0" },
			setupCatalog(api) {
				const corrupted = {
					...valid,
					entryTurnId: "missing_turn",
				} as ExtensionProcessDefinition;
				markDefinedProcess(corrupted);
				api.registerProcess(corrupted);
			},
		};

		await expect(buildExtensionCatalogFromModules([extension])).rejects.toThrow(
			/entry turn 'missing_turn' is not declared in turns/i,
		);
	});

	it("rejects processes whose transitions reference undeclared turns", async () => {
		const valid = defineProcess({
			id: "invalid_turn_ref_process",
			displayName: "Invalid Turn Ref",
			entry: "missing_turn",
			paramsCodec: { parse: () => ({}), serialize: (value) => value },
			stateCodec: { parse: () => ({}), serialize: (value) => value },
			initialState: () => ({}),
			turns: {
				missing_turn: llmTurn({
					availableTools: [],
					description: "Missing turn",
					branchType: "primary",
					context: "fresh",
					prompt: async () => "missing",
					turnEnd: { outcome: "done", params: {}, complete: true },
				}),
			},
		});
		const extension: LeitwerkExtensionModule = {
			manifest: { id: "invalid-turn-ref", version: "0.1.0" },
			setupCatalog(api) {
				const binding = valid.turns.get("missing_turn");
				const corrupted = {
					...valid,
					turns: new Map([
						[
							"missing_turn",
							{
								definition: binding?.definition as NonNullable<typeof binding>["definition"],
								transitions: [{ nextTurnId: "real_turn", outcome: "done" }],
							},
						],
					]),
				} as ExtensionProcessDefinition;
				markDefinedProcess(corrupted);
				api.registerProcess(corrupted);
			},
		};

		await expect(buildExtensionCatalogFromModules([extension])).rejects.toThrow(
			/must declare routing on the turn definition instead of authored transitions/,
		);
	});

	it("allows process-owned required semantic markdown refs to diverge across processes", async () => {
		const first = defineProcess({
			id: "required_semantic_plan",
			displayName: "Required semantic plan",
			entry: "review_turn",
			paramsCodec: { parse: () => ({}), serialize: (value) => value },
			stateCodec: { parse: () => ({}), serialize: (value) => value },
			initialState: () => ({}),
			turns: {
				review_turn: llmTurn({
					availableTools: [],
					description: "Review turn",
					branchType: "primary",
					context: "full",
					prompt: async () => "review",
					requiredSemanticMarkdownRefs: ["plan"],
					turnEnd: { outcome: "done", params: {}, complete: true },
				}),
			},
		});
		const second = defineProcess({
			id: "required_semantic_review",
			displayName: "Required semantic review",
			entry: "review_turn",
			paramsCodec: { parse: () => ({}), serialize: (value) => value },
			stateCodec: { parse: () => ({}), serialize: (value) => value },
			initialState: () => ({}),
			turns: {
				review_turn: llmTurn({
					availableTools: [],
					description: "Review turn",
					branchType: "primary",
					context: "full",
					prompt: async () => "review",
					requiredSemanticMarkdownRefs: ["review"],
					turnEnd: { outcome: "done", params: {}, complete: true },
				}),
			},
		});
		const extension: LeitwerkExtensionModule = {
			manifest: { id: "required-semantic-markdown", version: "0.1.0" },
			setupCatalog(api) {
				api.registerProcess(first);
				api.registerProcess(second);
			},
		};

		const catalog = await buildExtensionCatalogFromModules([extension]);
		expect(
			catalog.processes.get("required_semantic_plan")?.turns.get("review_turn")?.definition
				.requiredSemanticMarkdownRefs,
		).toEqual(["plan"]);
		expect(
			catalog.processes.get("required_semantic_review")?.turns.get("review_turn")?.definition
				.requiredSemanticMarkdownRefs,
		).toEqual(["review"]);
	});

	it("allows process-owned optional semantic markdown refs to diverge across processes", async () => {
		const first = defineProcess({
			id: "optional_semantic_review",
			displayName: "Optional semantic review",
			entry: "review_turn",
			paramsCodec: { parse: () => ({}), serialize: (value) => value },
			stateCodec: { parse: () => ({}), serialize: (value) => value },
			initialState: () => ({}),
			turns: {
				review_turn: llmTurn({
					availableTools: [],
					description: "Review turn",
					branchType: "primary",
					context: "full",
					prompt: async () => "review",
					optionalSemanticMarkdownRefs: ["review"],
					turnEnd: { outcome: "done", params: {}, complete: true },
				}),
			},
		});
		const second = defineProcess({
			id: "optional_semantic_plan",
			displayName: "Optional semantic plan",
			entry: "review_turn",
			paramsCodec: { parse: () => ({}), serialize: (value) => value },
			stateCodec: { parse: () => ({}), serialize: (value) => value },
			initialState: () => ({}),
			turns: {
				review_turn: llmTurn({
					availableTools: [],
					description: "Review turn",
					branchType: "primary",
					context: "full",
					prompt: async () => "review",
					optionalSemanticMarkdownRefs: ["plan"],
					turnEnd: { outcome: "done", params: {}, complete: true },
				}),
			},
		});
		const extension: LeitwerkExtensionModule = {
			manifest: { id: "optional-semantic-markdown", version: "0.1.0" },
			setupCatalog(api) {
				api.registerProcess(first);
				api.registerProcess(second);
			},
		};

		const catalog = await buildExtensionCatalogFromModules([extension]);
		expect(
			catalog.processes.get("optional_semantic_review")?.turns.get("review_turn")?.definition
				.optionalSemanticMarkdownRefs,
		).toEqual(["review"]);
		expect(
			catalog.processes.get("optional_semantic_plan")?.turns.get("review_turn")?.definition
				.optionalSemanticMarkdownRefs,
		).toEqual(["plan"]);
	});
});

describe("extension host setup", () => {
	it("runs server setup hooks in catalog dependency order", async () => {
		const calls: string[] = [];
		const dependency: LeitwerkExtensionModule = {
			manifest: { id: "ticket", version: "0.1.0" },
			async setupServer() {
				calls.push("ticket");
			},
		};
		const extension: LeitwerkExtensionModule = {
			manifest: { id: "implement", version: "0.1.0", requires: ["ticket"] },
			async setupServer() {
				calls.push("implement");
			},
		};
		const catalog = await buildExtensionCatalogFromModules([extension, dependency]);

		const capabilities = createCapabilityAccessor();
		await setupServerExtensions(catalog, {
			events: createEventBus(),
			get: capabilities.get,
			require: capabilities.require,
			onStart() {},
			onStop() {},
		});
		expect(calls).toEqual(["ticket", "implement"]);
	});

	it("runs worker setup hooks with a shared event bus", async () => {
		const seen: unknown[] = [];
		const extension: LeitwerkExtensionModule = {
			manifest: { id: "review", version: "0.1.0" },
			setupWorker(api) {
				api.events.on("worker.ready", (payload) => {
					seen.push(payload);
				});
			},
		};
		const catalog = await buildExtensionCatalogFromModules([extension]);
		const events = createEventBus();

		const capabilities = createCapabilityAccessor();
		await setupWorkerExtensions(catalog, {
			events,
			get: capabilities.get,
			require: capabilities.require,
		});
		events.emit("worker.ready", { instanceId: "ag1" });

		expect(seen).toEqual([{ instanceId: "ag1" }]);
	});
});
