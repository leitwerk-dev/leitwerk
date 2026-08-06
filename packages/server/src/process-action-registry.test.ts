import type { ProcessInstance, ProcessProject } from "@leitwerk-dev/domain";
import { createTestProcessInstance } from "@leitwerk-dev/extension-runtime/testing";
import { flow, type ProcessGraphView } from "@leitwerk-dev/process-sdk";
import { describe, expect, it } from "vitest";
import type { createServerProcessBuilder, TurnDefinition } from "../../process-sdk/src/index.js";
import { buildProcessActionRegistry } from "./process-action-registry.js";
import { collectProcessActionPlan } from "./process-engine/writes/build-process-action-writes.js";
import { getProcessGraph } from "./process-graph.js";
import { defineGraphFixtureProcess } from "./test-helpers/process-binding-fixtures.js";
import { createDefaultTestProcessGraphRegistry } from "./test-helpers/process-fixtures.js";
import { createTestDeps } from "./test-helpers/unit-deps.js";

const processGraphs = createDefaultTestProcessGraphRegistry();
const jiraProcessGraph = getProcessGraph(processGraphs, "jira_issue_process");

type ServerProcessHook = (api: ReturnType<typeof createServerProcessBuilder>) => void;

function createDefaultTurnDefinitions(): ReadonlyMap<string, TurnDefinition> {
	return new Map<string, TurnDefinition>([
		[
			"generate_plan",
			{
				id: "generate_plan",
				description: "Generate plan",
				kind: "llm",
				completionMode: "turn_end",
				branchType: "primary",
				context: "fresh",
				prompt: async () => "Generate plan",
				outcomes: { plan_saved: { description: "saved", parameters: {} } },
			},
		],
		[
			"plan_review",
			createPlanReviewTurn({
				actions: {
					approve_plan: { label: "Approve plan", acceptanceState: "accepted" },
					request_revision: { label: "Request revision", acceptanceState: "requires_changes" },
				},
			}),
		],
		[
			"implement",
			{
				id: "implement",
				description: "Implement",
				kind: "llm",
				completionMode: "turn_end",
				branchType: "primary",
				context: "full",
				prompt: async () => "Implement",
				outcomes: { done: { description: "done", parameters: {} } },
			},
		],
		[
			"handoff_review",
			{
				id: "handoff_review",
				description: "Handoff review",
				kind: "server_automatic",
				outcomes: { created: { description: "created", parameters: {} } },
				run: async () => ({ outcome: "created", params: {} }),
			},
		],
		[
			"run_llm_review",
			{
				id: "run_llm_review",
				description: "Run review",
				kind: "llm",
				completionMode: "turn_end",
				branchType: "leaf_branch",
				context: "full",
				prompt: async () => "Review",
				outcomes: {
					issues_found: { description: "issues", parameters: {} },
					no_issues: { description: "clean", parameters: {} },
				},
			},
		],
		[
			"address_review",
			{
				id: "address_review",
				description: "Address review",
				kind: "llm",
				completionMode: "turn_end",
				branchType: "primary",
				context: "full",
				prompt: async () => "Address review",
				outcomes: { comments_addressed: { description: "done", parameters: {} } },
			},
		],
		[
			"verify_build",
			{
				id: "verify_build",
				description: "Verify build",
				kind: "llm",
				completionMode: "turn_end",
				branchType: "primary",
				context: "full",
				prompt: async () => "Verify build",
				outcomes: {
					build_failing: { description: "failing", parameters: {} },
					build_passing: { description: "passing", parameters: {} },
				},
			},
		],
		[
			"fix_build",
			{
				id: "fix_build",
				description: "Fix build",
				kind: "llm",
				completionMode: "turn_end",
				branchType: "primary",
				context: "full",
				prompt: async () => "Fix build",
				outcomes: { build_fixed: { description: "fixed", parameters: {} } },
			},
		],
		[
			"commit_and_complete",
			{
				id: "commit_and_complete",
				description: "Commit and complete",
				kind: "llm",
				completionMode: "turn_end",
				branchType: "primary",
				context: "full",
				prompt: async () => "Commit",
				outcomes: { committed: { description: "committed", parameters: {} } },
			},
		],
		[
			"implementation_review",
			{
				id: "implementation_review",
				description: "Review the implementation",
				kind: "human",
				reviewSubject: { kind: "implementation" },
				reviewSemanticRef: "review",
				actions: {
					accept_change: { label: "accept_change", acceptanceState: "accepted" },
					apply_review: { label: "apply_review", acceptanceState: "requires_changes" },
				},
			},
		],
	]);
}

function withTurnDefinitionOverrides(
	overrides: ReadonlyMap<string, TurnDefinition>,
): ReadonlyMap<string, TurnDefinition> {
	const turnDefinitions = createDefaultTurnDefinitions();
	for (const [turnId, turnDefinition] of overrides) {
		turnDefinitions.set(turnId, turnDefinition);
	}
	return turnDefinitions;
}

function makeProcess(
	overrides: Partial<{
		id: string;
		displayName: string;
		graph: ProcessGraphView;
		server: ServerProcessHook;
		turnDefinitions: ReadonlyMap<string, TurnDefinition>;
	}> = {},
) {
	const graph = overrides.graph ?? jiraProcessGraph;
	const turnDefinitions = overrides.turnDefinitions ?? createDefaultTurnDefinitions();
	return defineGraphFixtureProcess({
		id: overrides.id ?? "jira_issue_process",
		displayName: overrides.displayName ?? "Implement Jira Issue",
		graph,
		turnDefinitions,
		paramsCodec: { parse: () => ({}), serialize: (value: unknown) => value },
		stateCodec: {
			parse: (value: unknown) => (value ?? {}) as Record<string, unknown>,
			serialize: (value: unknown) => value,
		},
		initialState: () => ({ reviewSubject: null }),
		...(overrides.server ? { server: overrides.server } : {}),
	});
}

function buildRegistry(options: { processes?: Array<ReturnType<typeof makeProcess>> } = {}) {
	return buildProcessActionRegistry({
		processes: new Map(
			(options.processes ?? [makeProcess()]).map((process) => [process.id, process]),
		),
	});
}

function makeFakeAgent(overrides: Partial<ProcessInstance> = {}): ProcessInstance {
	return createTestProcessInstance({
		selectedTurnId: "plan_review",
		lifecycleStatus: "waiting",
		...overrides,
	});
}

function createPlanReviewProcess(reviewSubject: { kind: "plan" } | null = { kind: "plan" }) {
	return makeFakeAgent({
		selectedTurnId: "plan_review",
		lifecycleStatus: "waiting",
		stateJson: JSON.stringify({ reviewSubject }),
	});
}

function createImplementationReviewProcess() {
	return makeFakeAgent({
		selectedTurnId: "implementation_review",
		lifecycleStatus: "waiting",
		stateJson: JSON.stringify({ reviewSubject: { kind: "implementation" } }),
	});
}

function makeFakeProject(instanceId: string): ProcessProject {
	return {
		id: "prj_1",
		instanceId,
		key: "backend",
		repoLocator: "https://gitlab.example.com/team/backend.git",
		baseBranch: "main",
		workBranch: "feature/test",
		externalId: null,
		externalUrl: null,
		pipelineStatus: null,
		metadata: null,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
}

function getActionOrThrow(
	registry: ReturnType<typeof buildProcessActionRegistry>,
	processId: string,
	actionId: string,
) {
	const action = registry.getAction(processId, actionId);
	expect(action).toBeDefined();
	if (!action) {
		throw new Error(`Missing action ${processId}.${actionId}`);
	}
	return action;
}

function createVisibilityCtx(
	process: ProcessInstance,
	state: Record<string, unknown> = {},
	projects: ProcessProject[] = [],
) {
	return {
		process,
		projects,
		params: {},
		state,
		async transition() {},
		emitEvent() {},
		readSemanticTurnResultMarkdown() {
			return null;
		},
		readProductTurnResultMarkdown() {
			return null;
		},
		queueInput() {},
	};
}

function createPlanReviewTurn(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		id: "plan_review",
		description: "Review the plan",
		kind: "human" as const,
		reviewSubject: { kind: "plan" as const },
		reviewSemanticRef: "plan",
		actions: {},
		...overrides,
	};
}

function createHumanReviewTurns() {
	return new Map([
		[
			"plan_review",
			createPlanReviewTurn({
				actions: {
					approve_plan: { label: "Approve plan", acceptanceState: "accepted" },
					request_revision: { label: "Request revision", acceptanceState: "requires_changes" },
				},
			}),
		],
		[
			"implementation_review",
			{
				id: "implementation_review",
				description: "Review the implementation",
				kind: "human" as const,
				reviewSubject: { kind: "implementation" as const },
				reviewSemanticRef: "review",
				actions: {
					accept_change: { label: "accept_change", acceptanceState: "accepted" },
					apply_review: { label: "apply_review", acceptanceState: "requires_changes" },
				},
			},
		],
	]);
}

function collectPlan(
	process: ProcessInstance,
	registry: ReturnType<typeof buildProcessActionRegistry>,
	actionId: string,
	input: Record<string, unknown> = {},
) {
	return collectProcessActionPlan({
		process,
		projects: [makeFakeProject(process.id)],
		processGraphs,
		...registry.resolveContextData(process.processId, process),
		turnRecords: createTestDeps().turnRecords,
		action: getActionOrThrow(registry, process.processId, actionId),
		input,
		isVisible: true,
	});
}

describe("ProcessActionRegistry", () => {
	it("builds server definitions from catalog processes", () => {
		const registry = buildRegistry({
			processes: [
				makeProcess({
					id: "test_process",
					displayName: "Test",
					server(api) {
						api.action({ id: "do_thing", label: "Do thing", async plan() {} });
					},
				}),
			],
		});

		expect(registry.getAction("test_process", "do_thing")).toBeDefined();
		expect(registry.getAction("test_process", "nonexistent")).toBeUndefined();
		expect(registry.getAction("unknown_process", "do_thing")).toBeUndefined();
	});

	it("does not surface standalone actions outside a current human turn", () => {
		const registry = buildRegistry({
			processes: [
				makeProcess({
					id: "test_process",
					displayName: "Test",
					server(api) {
						api.action({ id: "do_thing", label: "Do thing", async plan() {} });
					},
				}),
			],
		});

		expect(
			registry.listVisibleActions("test_process", createVisibilityCtx(makeFakeAgent())),
		).toEqual([]);
	});

	it("derives human-turn action visibility from the current turn without action-level mapping", () => {
		const registry = buildRegistry({
			processes: [
				makeProcess({
					server(api) {
						api.action({ id: "approve_plan", label: "Approve", async plan() {} });
						api.action({
							id: "request_revision",
							label: "Request revision",
							form: { id: "request_revision_form", title: "Request revision", fields: [] },
							async plan() {},
						});
					},
					turnDefinitions: withTurnDefinitionOverrides(
						new Map([
							[
								"plan_review",
								createPlanReviewTurn({
									actions: {
										approve_plan: { label: "Approve plan", acceptanceState: "accepted" },
										request_revision: {
											label: "Request revision",
											acceptanceState: "requires_changes",
										},
									},
								}),
							],
						]),
					),
				}),
			],
		});

		expect(registry.isTurnScopedAction("jira_issue_process", "approve_plan")).toBe(true);
		expect(registry.isTurnScopedAction("jira_issue_process", "request_revision")).toBe(true);
		expect(registry.isTurnScopedAction("jira_issue_process", "handoff_review")).toBe(false);
		expect(
			registry.listVisibleActions(
				"jira_issue_process",
				createVisibilityCtx(createPlanReviewProcess(), { reviewSubject: { kind: "plan" } }),
			),
		).toEqual([
			expect.objectContaining({
				id: "approve_plan",
				label: "Approve plan",
				description: null,
				form: undefined,
			}),
			expect.objectContaining({
				id: "request_revision",
				label: "Request revision",
				description: null,
			}),
		]);
	});

	it("resolves current-turn scheduling previews without executing the action", () => {
		const registry = buildRegistry({
			processes: [
				makeProcess({
					server(api) {
						api.action({ id: "approve_plan", label: "Approve", plan: async () => {} });
					},
					turnDefinitions: withTurnDefinitionOverrides(
						new Map([
							[
								"plan_review",
								createPlanReviewTurn({
									actions: {
										approve_plan: {
											label: "Approve plan",
											acceptanceState: "accepted",
											preview: { kind: "trigger", trigger: "plan_approved" },
											schedulable: true,
										},
									},
								}),
							],
						]),
					),
				}),
			],
		});
		const process = createPlanReviewProcess();

		expect(registry.resolveActionScheduling("jira_issue_process", process, "approve_plan")).toEqual(
			{
				definition: { preview: { kind: "trigger", trigger: "plan_approved" } },
				candidateSelectedTurnId: "implement",
				lifecycleStatus: null,
			},
		);
	});

	it("resolves action previews independently from scheduling support", () => {
		const registry = buildRegistry({
			processes: [
				makeProcess({
					server(api) {
						api.action({ id: "approve_plan", label: "Approve", plan: async () => {} });
					},
					turnDefinitions: withTurnDefinitionOverrides(
						new Map([
							[
								"plan_review",
								createPlanReviewTurn({
									actions: {
										approve_plan: {
											label: "Approve plan",
											acceptanceState: "accepted",
											description: "Approve the saved plan and continue.",
											preview: { kind: "trigger", trigger: "plan_approved" },
										},
									},
								}),
							],
						]),
					),
				}),
			],
		});
		const process = createPlanReviewProcess();

		expect(registry.resolveActionPreview("jira_issue_process", process, "approve_plan")).toEqual({
			definition: { kind: "trigger", trigger: "plan_approved" },
			candidateSelectedTurnId: "implement",
			lifecycleStatus: null,
		});
		expect(
			registry.listVisibleActions(
				"jira_issue_process",
				createVisibilityCtx(process, { reviewSubject: { kind: "plan" } }),
			),
		).toEqual([
			expect.objectContaining({
				id: "approve_plan",
				label: "Approve plan",
				description: "Approve the saved plan and continue.",
				preview: expect.objectContaining({
					definition: { kind: "trigger", trigger: "plan_approved" },
					candidateSelectedTurnId: "implement",
					lifecycleStatus: null,
				}),
			}),
		]);
	});

	it("resolves UI human-turn actions from the current review subject", () => {
		const registry = buildRegistry({
			processes: [
				makeProcess({ turnDefinitions: withTurnDefinitionOverrides(createHumanReviewTurns()) }),
			],
		});
		const planProcess = createPlanReviewProcess();
		const implementationProcess = createImplementationReviewProcess();

		expect(
			registry.resolveTurnScopedAction("jira_issue_process", planProcess, "approve_plan", "ui"),
		).toMatchObject({
			kind: "ui_human_action",
			turnId: "plan_review",
			turnType: "human",
			acceptanceState: "accepted",
			semanticEntryRefKey: "plan",
		});
		expect(
			registry.resolveTurnScopedAction(
				"jira_issue_process",
				implementationProcess,
				"apply_review",
				"ui",
			),
		).toMatchObject({
			kind: "ui_human_action",
			turnId: "implementation_review",
			turnType: "human",
			acceptanceState: "requires_changes",
			semanticEntryRefKey: "review",
		});
		expect(
			registry.resolveTurnScopedAction("jira_issue_process", planProcess, "accept_change", "ui"),
		).toBeNull();
	});

	it("exposes external trigger summaries for the selected human turn", () => {
		const poemCreatorGraph: ProcessGraphView = {
			id: "poem_creator_process",
			entryTurnIds: new Set(["draft_poem"]),
			turns: new Map([
				["draft_poem", { turnType: "llm" as const }],
				["poem_review", { turnType: "human" as const, reviewSubject: { kind: "plan" as const } }],
			]),
		};
		const registry = buildRegistry({
			processes: [
				makeProcess({
					id: "poem_creator_process",
					displayName: "Poem Creator",
					graph: poemCreatorGraph,
					turnDefinitions: new Map([
						[
							"draft_poem",
							{
								id: "draft_poem",
								description: "Draft the poem",
								kind: "llm",
								completionMode: "turn_end",
								branchType: "primary",
								context: "fresh",
								prompt: async () => "Draft poem",
								outcomes: { draft_ready: { description: "ready", parameters: {} } },
							},
						],
						[
							"poem_review",
							{
								id: "poem_review",
								description: "Review the poem",
								kind: "human",
								reviewSubject: { kind: "plan" },
								actions: {
									request_poem_revision: {
										label: "Request poem revision",
										acceptanceState: "requires_changes",
										externalTriggers: [
											{
												id: "poem_review_file",
												label: "Configured poem review file",
												description: "Write revision feedback to the poem review trigger file.",
											},
										],
									},
								},
								commentary: "Review the poem or trigger a revision externally.",
							},
						],
					]),
				}),
			],
		});
		const process = makeFakeAgent({
			processId: "poem_creator_process",
			selectedTurnId: "poem_review",
			lifecycleStatus: "waiting",
			stateJson: JSON.stringify({ reviewSubject: { kind: "plan" } }),
		});

		expect(registry.getSelectedTurnSummary("poem_creator_process", process)).toEqual({
			turnId: "poem_review",
			kind: "human",
			description: "Review the poem",
			commentary: "Review the poem or trigger a revision externally.",
			externalTriggers: [
				{
					id: "poem_review_file",
					kind: "human_action_external_trigger",
					label: "Configured poem review file",
					description: "Write revision feedback to the poem review trigger file.",
				},
			],
		});
		expect(
			registry.resolveTurnScopedAction(
				"poem_creator_process",
				process,
				"request_poem_revision",
				"external",
			),
		).toMatchObject({
			kind: "external_human_trigger",
			turnId: "poem_review",
			turnType: "external",
			reviewSubject: { kind: "plan" },
			acceptanceState: "requires_changes",
			externalTrigger: { id: "poem_review_file", actionId: "request_poem_revision" },
		});
	});

	it("surfaces automatic selected turns as leitwerk-owned steps", () => {
		const automaticGraph: ProcessGraphView = {
			id: "automatic_process",
			entryTurnIds: new Set(["implementation_review"]),
			turns: new Map([
				[
					"implementation_review",
					{ turnType: "human" as const, reviewSubject: { kind: "implementation" as const } },
				],
				["commit_and_merge", { turnType: "automatic" as const }],
			]),
		};
		const registry = buildRegistry({
			processes: [
				makeProcess({
					id: "automatic_process",
					displayName: "Automatic Process",
					graph: automaticGraph,
					turnDefinitions: new Map([
						[
							"implementation_review",
							{
								id: "implementation_review",
								description: "Review the implementation",
								kind: "human",
								reviewSubject: { kind: "implementation" },
								actions: {},
							},
						],
						[
							"commit_and_merge",
							{
								id: "commit_and_merge",
								description: "Commit and merge",
								kind: "automatic",
								outcomes: {
									finalized: { description: "done", parameters: {} },
								},
							},
						],
					]),
				}),
			],
		});
		const process = makeFakeAgent({
			processId: "automatic_process",
			selectedTurnId: "commit_and_merge",
			lifecycleStatus: "active",
		});

		expect(registry.getSelectedTurnSummary("automatic_process", process)).toEqual({
			turnId: "commit_and_merge",
			kind: "automatic",
			description: "Commit and merge",
			commentary: null,
			externalTriggers: [],
		});
	});

	it("resolves selected external turns without UI actions", () => {
		const externalGraph: ProcessGraphView = {
			id: "single_prompt_external_complete_process",
			entryTurnIds: new Set(["run_single_prompt"]),
			turns: new Map([
				["run_single_prompt", { turnType: "llm" as const }],
				["await_external_prompt_completion", { turnType: "external" as const }],
			]),
		};
		const externalCompletionTurn = flow
			.external("await_external_prompt_completion")
			.description("Wait for an external completion trigger");
		externalCompletionTurn
			.from({
				kind: "example.file.presence",
				label: "Prompt-complete file",
				description: "Write to the prompt-complete trigger file.",
				config: { path: "/tmp/complete-prompt" },
			})
			.complete();

		const registry = buildRegistry({
			processes: [
				makeProcess({
					id: "single_prompt_external_complete_process",
					displayName: "Single Prompt + External Complete",
					graph: externalGraph,
					turnDefinitions: new Map([
						[
							"run_single_prompt",
							{
								id: "run_single_prompt",
								description: "Run prompt",
								kind: "llm",
								completionMode: "turn_end",
								branchType: "primary",
								context: "fresh",
								prompt: async () => "Run prompt",
								outcomes: { completed: { description: "done", parameters: {} } },
							},
						],
						[
							"await_external_prompt_completion",
							{
								id: "await_external_prompt_completion",
								...externalCompletionTurn.definition,
							},
						],
					]),
				}),
			],
		});
		const process = makeFakeAgent({
			processId: "single_prompt_external_complete_process",
			selectedTurnId: "await_external_prompt_completion",
			lifecycleStatus: "waiting",
		});

		expect(
			registry.listVisibleActions(
				"single_prompt_external_complete_process",
				createVisibilityCtx(process),
			),
		).toEqual([]);
		expect(
			registry.getSelectedTurnSummary("single_prompt_external_complete_process", process),
		).toEqual({
			turnId: "await_external_prompt_completion",
			kind: "external",
			description: "Wait for an external completion trigger",
			commentary: null,
			externalTriggers: [
				{
					id: "await_external_prompt_completion:example.file.presence:0",
					kind: "example.file.presence",
					label: "Prompt-complete file",
					description: "Write to the prompt-complete trigger file.",
				},
			],
		});
		expect(
			registry.resolveTurnScopedAction(
				"single_prompt_external_complete_process",
				process,
				"complete_external_prompt",
				"external",
			),
		).toBeNull();
	});
});

describe("collectProcessActionPlan", () => {
	it("collects turn selections and deferred events", async () => {
		const process = makeFakeAgent();
		const registry = buildRegistry({
			processes: [
				makeProcess({
					server(api) {
						api.action({
							id: "approve_plan",
							label: "Approve plan",
							async plan(_input, ctx) {
								await ctx.transition({ turnId: "implement", trigger: "plan_approved" });
								ctx.emitEvent("plan_approved", { externalId: null, planRevision: 1 });
							},
						});
					},
				}),
			],
		});
		const planned = await collectPlan(process, registry, "approve_plan");

		expect("ok" in planned).toBe(false);
		if ("ok" in planned) return;
		expect(planned.processPatch.selectedTurnId).toBe("implement");
		expect(planned.extensionEvents).toEqual([
			{
				type: "plan_approved",
				payload: {
					instanceId: process.id,
					externalId: null,
					planRevision: 1,
				},
			},
		]);
		expect(planned.workerIntent).toEqual({ kind: "reconcile" });
	});

	it("collects queued inputs", async () => {
		const process = makeFakeAgent();
		const registry = buildRegistry({
			processes: [
				makeProcess({
					server(api) {
						api.action({
							id: "request_revision",
							label: "Request revision",
							async plan(input, ctx) {
								await ctx.transition({ turnId: "generate_plan", trigger: "revision_requested" });
								ctx.queueInput({
									source: "app_steer",
									kind: "instruction",
									bodyMarkdown: input.message as string,
								});
							},
						});
					},
				}),
			],
		});
		const planned = await collectPlan(process, registry, "request_revision", {
			message: "Please add error handling",
		});

		expect("ok" in planned).toBe(false);
		if ("ok" in planned) return;
		expect(planned.queuedInputs).toEqual([
			{
				source: "app_steer",
				kind: "instruction",
				target: null,
				bodyMarkdown: "Please add error handling",
			},
		]);
		expect(planned.processPatch.selectedTurnId).toBe("generate_plan");
	});

	it("preserves explicit restart-worker transition effects", async () => {
		const process = createTestProcessInstance({
			selectedTurnId: "handoff_review",
			lifecycleStatus: "active",
		});
		const registry = buildRegistry({
			processes: [
				makeProcess({
					server(api) {
						api.action({
							id: "handoff_review",
							label: "Handoff review",
							async plan(_input, ctx) {
								await ctx.transition({
									turnId: "run_llm_review",
									state: { reviewSubject: { kind: "implementation" } },
									effect: { runtime: "restart_worker" },
								});
							},
						});
					},
				}),
			],
		});
		const planned = await collectPlan(process, registry, "handoff_review");

		expect("ok" in planned).toBe(false);
		if ("ok" in planned) return;
		expect(planned.workerIntent).toEqual({ kind: "restart_worker" });
		expect(planned.metadata).toBeUndefined();
	});
});
