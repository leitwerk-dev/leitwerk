import type { ProcessInstance } from "@leitwerk-dev/domain";
import type {
	createServerProcessBuilder,
	ProcessGraphView,
	TurnDefinition,
} from "@leitwerk-dev/process-sdk";
import { describe, expect, it } from "vitest";
import { buildProcessActionRegistry } from "../../process-action-registry.js";
import { getProcessGraph } from "../../process-graph.js";
import { defineGraphFixtureProcess } from "../../test-helpers/process-binding-fixtures.js";
import { createDefaultTestProcessGraphRegistry } from "../../test-helpers/process-fixtures.js";
import {
	createCommentsAddressedOutcomeTools,
	createCommittedOutcomeTools,
	createDoneOutcomeTools,
	createPlanSavedOutcomeTools,
	createTestLlmTurn,
} from "../../test-helpers/turn-fixtures.js";
import { createTestDeps } from "../../test-helpers/unit-deps.js";
import { buildTurnOutcomeWrites } from "./build-turn-outcome-writes.js";

const processGraphs = createDefaultTestProcessGraphRegistry();
const ticketProcessGraph = getProcessGraph(processGraphs, "ticket_issue_process");

const testTurns = new Map<string, TurnDefinition>([
	["generate_plan", createTestLlmTurn("generate_plan", createPlanSavedOutcomeTools())],
	[
		"plan_review",
		{
			id: "plan_review",
			description: "Plan review",
			kind: "human",
			actions: {},
		},
	],
	[
		"implement",
		createTestLlmTurn("implement", createDoneOutcomeTools({ includeChangedProjects: true })),
	],
	[
		"handoff_review",
		createTestLlmTurn("handoff_review", {
			created: { description: "created", parameters: {} },
		}),
	],
	[
		"run_llm_review",
		createTestLlmTurn("run_llm_review", {
			issues_found: { description: "issues", parameters: {} },
			no_issues: { description: "clean", parameters: {} },
		}),
	],
	["address_review", createTestLlmTurn("address_review", createCommentsAddressedOutcomeTools())],
	[
		"verify_build",
		createTestLlmTurn("verify_build", {
			build_failing: { description: "failing", parameters: {} },
			build_passing: { description: "passing", parameters: {} },
		}),
	],
	[
		"fix_build",
		createTestLlmTurn("fix_build", {
			build_fixed: { description: "fixed", parameters: {} },
			build_unfixable: { description: "unfixable", parameters: {} },
		}),
	],
	["commit_and_complete", createTestLlmTurn("commit_and_complete", createCommittedOutcomeTools())],
	[
		"implementation_review",
		{
			id: "implementation_review",
			description: "Implementation review",
			kind: "human",
			actions: {},
		},
	],
	[
		"mr_polish_review",
		{
			id: "mr_polish_review",
			description: "MR polish review",
			kind: "human",
			actions: {},
		},
	],
]);

function makeProcess(
	server: (api: ReturnType<typeof createServerProcessBuilder>) => void,
	graph: ProcessGraphView = ticketProcessGraph,
	processId = "ticket_issue_process",
) {
	return defineGraphFixtureProcess({
		id: processId,
		displayName: "Implement Ticket Issue",
		graph,
		turnDefinitions: testTurns,
		paramsCodec: { parse: () => ({}), serialize: (v: unknown) => v },
		stateCodec: { parse: () => ({}), serialize: (v: unknown) => v },
		initialState: () => ({}),
		server,
	});
}

function createAgent(overrides: Partial<ProcessInstance> = {}): {
	deps: ReturnType<typeof createTestDeps>;
	process: ProcessInstance;
} {
	const deps = createTestDeps();
	const process = deps.processes.create({
		processId: "ticket_issue_process",
		selectedTurnId: "generate_plan",
		lifecycleStatus: "active",
		...overrides,
	});
	return { deps, process };
}

describe("buildTurnOutcomeWrites", () => {
	it("plans generate_plan.plan_saved from process turn outcome handlers", async () => {
		const { deps, process } = createAgent();
		const registry = buildProcessActionRegistry({
			processes: new Map([
				[
					"ticket_issue_process",
					makeProcess((api) => {
						api.onTurnOutcome("generate_plan", async (event, ctx) => {
							if (event.outcome !== "plan_saved") {
								return;
							}
							await ctx.transition({
								turnId: "plan_review",
								lifecycleStatus: "waiting",
								state: {},
							});
							const summary = typeof event.params.summary === "string" ? event.params.summary : "";
							const planMarkdown =
								typeof event.params.planMarkdown === "string" ? event.params.planMarkdown : "";
							const acceptanceCriteria = Array.isArray(event.params.acceptanceCriteria)
								? event.params.acceptanceCriteria.filter(
										(value): value is string => typeof value === "string",
									)
								: [];
							ctx.applyLifecycleEffects?.({
								processPatch: { planRevision: 1 },
							});
							ctx.emitEvent("plan_saved", {
								planRevision: 1,
								summary,
								planMarkdown,
								acceptanceCriteria,
							});
						});
					}),
				],
			]),
		});
		const planned = await buildTurnOutcomeWrites({
			process,
			projects: [],
			turnRecords: deps.turnRecords,
			processGraphs,
			payload: {
				instanceId: process.id,
				turnRecordId: "trn_plan_1",
				turnId: "generate_plan",
				turnType: "llm",
				outcome: "plan_saved",
				params: {
					planMarkdown: "## Plan",
					acceptanceCriteria: ["A"],
					summary: "Initial plan",
				},
			},
			processActionRegistry: registry,
		});
		expect("ok" in planned).toBe(false);
		if ("ok" in planned) return;
		expect(planned.processPatch).toMatchObject({
			selectedTurnId: "plan_review",
			lifecycleStatus: "waiting",
			planRevision: 1,
			stateJson: JSON.stringify({}),
		});
		expect(planned.extensionEvents).toEqual(
			expect.arrayContaining([
				{
					type: "plan_saved",
					payload: {
						instanceId: process.id,
						planRevision: 1,
						summary: "Initial plan",
						planMarkdown: "## Plan",
						acceptanceCriteria: ["A"],
					},
				},
				{
					type: "turn_outcome",
					payload: {
						instanceId: process.id,
						turnRecordId: "trn_plan_1",
						turnId: "generate_plan",
						outcome: "plan_saved",
						params: {
							planMarkdown: "## Plan",
							acceptanceCriteria: ["A"],
							summary: "Initial plan",
						},
						turnResultMarkdown: null,
					},
				},
			]),
		);
	});

	it("records outcomes without applying fallback effects when no turn outcome handler is registered", async () => {
		const { deps, process } = createAgent({
			selectedTurnId: "address_review",
			lifecycleStatus: "active",
		});
		const registry = buildProcessActionRegistry({
			processes: new Map([["ticket_issue_process", makeProcess(() => {})]]),
		});
		const planned = await buildTurnOutcomeWrites({
			process,
			projects: [],
			turnRecords: deps.turnRecords,
			processGraphs,
			payload: {
				instanceId: process.id,
				turnRecordId: "trn_polish_1",
				turnId: "address_review",
				turnType: "llm",
				outcome: "comments_addressed",
				params: { summary: "Addressed comments" },
			},
			processActionRegistry: registry,
		});
		expect("ok" in planned).toBe(false);
		if ("ok" in planned) return;
		expect(planned.processPatch).toMatchObject({
			selectedTurnId: "verify_build",
			lifecycleStatus: "error",
			currentExecution: { kind: "worker_start" },
		});
		expect(planned.turnStartWrites).toEqual([
			expect.objectContaining({
				kind: "create",
				input: expect.objectContaining({
					turnId: "verify_build",
					state: expect.objectContaining({ kind: "preparation_failed" }),
				}),
			}),
		]);
		expect(planned.extensionEvents).toEqual([
			{
				type: "turn_outcome",
				payload: {
					instanceId: process.id,
					turnRecordId: "trn_polish_1",
					turnId: "address_review",
					outcome: "comments_addressed",
					params: { summary: "Addressed comments" },
					turnResultMarkdown: null,
				},
			},
		]);
	});

	it("records unrouted outcomes without reconciling the worker", async () => {
		const { deps, process } = createAgent({
			processId: "mr_polish_process",
			selectedTurnId: "fix_build",
			lifecycleStatus: "active",
		});
		const mrPolishGraph = getProcessGraph(processGraphs, "mr_polish_process");
		const registry = buildProcessActionRegistry({
			processes: new Map([
				["mr_polish_process", makeProcess(() => {}, mrPolishGraph, "mr_polish_process")],
			]),
		});
		const planned = await buildTurnOutcomeWrites({
			process,
			projects: [],
			turnRecords: deps.turnRecords,
			processGraphs,
			payload: {
				instanceId: process.id,
				turnRecordId: "trn_fix_1",
				turnId: "fix_build",
				turnType: "llm",
				outcome: "build_unfixable",
				params: {},
			},
			processActionRegistry: registry,
		});
		expect("ok" in planned).toBe(true);
		if (!("ok" in planned)) return;
		expect(planned.code).toBe("outcome_not_registered");
	});

	it("emits review_requested from process turn outcome handlers", async () => {
		const { deps, process } = createAgent({
			selectedTurnId: "implement",
			lifecycleStatus: "active",
		});
		const registry = buildProcessActionRegistry({
			processes: new Map([
				[
					"ticket_issue_process",
					makeProcess((api) => {
						api.onTurnOutcome("implement", async (event, ctx) => {
							if (event.outcome === "done") {
								ctx.emitEvent("review_requested", {
									changedProjects: Array.isArray(event.params.changedProjects)
										? event.params.changedProjects.filter(
												(value): value is string => typeof value === "string",
											)
										: [],
								});
							}
						});
					}),
				],
			]),
		});
		const project = deps.projects.create({
			instanceId: process.id,
			key: "backend",
			repoLocator: "https://example.com/backend.git",
			baseBranch: "main",
			workBranch: "feature/test",
		});
		const planned = await buildTurnOutcomeWrites({
			process,
			projects: [project],
			turnRecords: deps.turnRecords,
			processGraphs,
			payload: {
				instanceId: process.id,
				turnRecordId: "trn_impl_1",
				turnId: "implement",
				turnType: "llm",
				outcome: "done",
				params: { summary: "done", changedProjects: ["backend"] },
			},
			processActionRegistry: registry,
		});
		expect("ok" in planned).toBe(false);
		if ("ok" in planned) return;
		expect(planned.extensionEvents).toEqual(
			expect.arrayContaining([
				{
					type: "review_requested",
					payload: { instanceId: process.id, changedProjects: ["backend"] },
				},
				{
					type: "turn_outcome",
					payload: {
						instanceId: process.id,
						turnRecordId: "trn_impl_1",
						turnId: "implement",
						outcome: "done",
						params: { summary: "done", changedProjects: ["backend"] },
						turnResultMarkdown: null,
					},
				},
			]),
		);
	});

	it("applies outcome state before following the declared outcome transition", async () => {
		const { deps } = createAgent({ selectedTurnId: "address_review", lifecycleStatus: "active" });
		const process = deps.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "commit_and_complete",
			lifecycleStatus: "active",
			stateJson: JSON.stringify({ readyForHumanReview: false }),
		});
		const registry = buildProcessActionRegistry({
			processes: new Map([
				[
					"ticket_issue_process",
					defineGraphFixtureProcess({
						id: "ticket_issue_process",
						displayName: "Implement Ticket Issue",
						graph: ticketProcessGraph,
						turnDefinitions: testTurns,
						paramsCodec: { parse: () => ({}), serialize: (v: unknown) => v },
						stateCodec: {
							parse: (value: unknown) => {
								const record =
									typeof value === "object" && value !== null
										? (value as Record<string, unknown>)
										: {};
								return {
									readyForHumanReview: record.readyForHumanReview === true,
								};
							},
							serialize: (v: unknown) => v,
						},
						initialState: () => ({ readyForHumanReview: false }),
						server(api) {
							api.onTurnOutcome("commit_and_complete", async (_event, ctx) => {
								await ctx.transition({
									state: {
										...ctx.state,
										readyForHumanReview: true,
									},
								});
							});
						},
					}),
				],
			]),
		});
		const planned = await buildTurnOutcomeWrites({
			process,
			projects: [],
			turnRecords: deps.turnRecords,
			processGraphs,
			payload: {
				instanceId: process.id,
				turnRecordId: "trn_commit_1",
				turnId: "commit_and_complete",
				turnType: "llm",
				outcome: "committed",
				params: { summary: "committed" },
			},
			processActionRegistry: registry,
		});
		expect("ok" in planned).toBe(false);
		if ("ok" in planned) return;
		expect(planned.processPatch).toMatchObject({
			selectedTurnId: "implementation_review",
			lifecycleStatus: "waiting",
			stateJson: JSON.stringify({
				readyForHumanReview: true,
			}),
		});
		expect(planned.changedFields).toEqual(expect.arrayContaining(["stateJson", "selectedTurnId"]));
	});

	it("lets outcome effects read and extend state returned by a server automatic run", async () => {
		const { deps, process } = createAgent({
			selectedTurnId: "handoff_review",
			stateJson: JSON.stringify({ beforeRun: true }),
		});
		const registry = buildProcessActionRegistry({
			processes: new Map([
				[
					"ticket_issue_process",
					defineGraphFixtureProcess({
						id: "ticket_issue_process",
						displayName: "Implement Ticket Issue",
						graph: ticketProcessGraph,
						turnDefinitions: testTurns,
						paramsCodec: { parse: () => ({}), serialize: (v: unknown) => v },
						stateCodec: {
							parse: (value: unknown) =>
								typeof value === "object" && value !== null
									? (value as Record<string, unknown>)
									: {},
							serialize: (v: unknown) => v,
						},
						initialState: () => ({}),
						server(api) {
							api.onTurnOutcome("handoff_review", async (_event, ctx) => {
								await ctx.transition({
									state: {
										...ctx.state,
										effectApplied: true,
									},
								});
							});
						},
					}),
				],
			]),
		});
		const planned = await buildTurnOutcomeWrites({
			process,
			projects: [],
			turnRecords: deps.turnRecords,
			processGraphs,
			payload: {
				instanceId: process.id,
				turnRecordId: "trn_server_auto_1",
				turnId: "handoff_review",
				turnType: "server_automatic",
				outcome: "created",
				params: {},
				state: { fromRun: true },
			},
			processActionRegistry: registry,
		});
		expect("ok" in planned).toBe(false);
		if ("ok" in planned) return;
		expect(JSON.parse(planned.processPatch.stateJson ?? "{}")).toEqual({
			fromRun: true,
			effectApplied: true,
		});
	});
});
