import type { ProcessInstance, ProcessProject } from "@leitwerk-dev/domain";
import {
	createTestProcessInstance,
	createTestProcessProject,
	createTestServerProcessContext,
} from "@leitwerk-dev/extension-runtime/testing";
import {
	type DefinedProcessInput,
	defineProcess,
	emptyParamsCodec,
	flow,
	type HumanTurnDefinition,
	humanTurn,
} from "@leitwerk-dev/process-sdk";
import { describe, expect, it } from "vitest";
import { buildProcessActionRegistry } from "./process-action-registry.js";
import { collectProcessActionPlan } from "./process-engine/writes/build-process-action-writes.js";
import {
	createDefaultTestProcessGraphRegistry,
	createFixtureAutomaticTurn,
	createFixtureLlmTurn,
} from "./test-helpers/process-fixtures.js";

const processGraphs = createDefaultTestProcessGraphRegistry();

type TestProcessInput = DefinedProcessInput<Record<string, never>, Record<string, never>>;

function makeProcess(input: Partial<TestProcessInput> = {}) {
	const process = defineProcess({
		id: "ticket_issue_process",
		displayName: "Test process",
		entry: "plan_review",
		paramsCodec: emptyParamsCodec,
		stateCodec: {
			parse: (value: unknown) => (value ?? {}) as Record<string, never>,
			serialize: (value: Record<string, never>) => value,
		},
		initialState: () => ({}),
		...input,
		turns: {
			plan_review: createPlanReviewTurn(),
			implement: createFixtureLlmTurn("Implement"),
			generate_plan: createFixtureLlmTurn("Generate plan"),
			...input.turns,
		},
	});
	// Exercise server registrations independently of compiled human action handlers.
	if (input.server) process.server = input.server;
	return process;
}

function buildRegistry(processes = [makeProcess()]) {
	return buildProcessActionRegistry({
		processes: new Map(processes.map((process) => [process.id, process])),
	});
}

function makeFakeAgent(overrides: Partial<ProcessInstance> = {}): ProcessInstance {
	return createTestProcessInstance({
		selectedTurnId: "plan_review",
		lifecycleStatus: "waiting",
		...overrides,
	});
}

function createImplementationReviewProcess() {
	return makeFakeAgent({
		selectedTurnId: "implementation_review",
		lifecycleStatus: "waiting",
		stateJson: JSON.stringify({}),
	});
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
	return createTestServerProcessContext({ process, projects, params: {}, state });
}

function createPlanReviewTurn(
	overrides: Partial<HumanTurnDefinition<Record<string, never>, Record<string, never>>> = {},
) {
	return humanTurn({
		description: "Review the plan",
		reviewSemanticRef: "plan",
		actions: {
			approve_plan: { label: "Approve plan", acceptanceState: "accepted", complete: true },
			request_revision: {
				label: "Request revision",
				acceptanceState: "requires_changes",
				complete: true,
			},
		},
		...overrides,
	});
}

function collectPlan(
	process: ProcessInstance,
	registry: ReturnType<typeof buildProcessActionRegistry>,
	actionId: string,
	input: Record<string, unknown> = {},
) {
	return collectProcessActionPlan({
		process,
		projects: [createTestProcessProject({ instanceId: process.id })],
		processGraphs,
		...registry.resolveContextData(process.processId, process),
		turnRecords: { getById: () => null },
		action: getActionOrThrow(registry, process.processId, actionId),
		input,
		isVisible: true,
	});
}

describe("ProcessActionRegistry", () => {
	it("builds server definitions from catalog processes", () => {
		const registry = buildRegistry([
			makeProcess({
				id: "test_process",
				displayName: "Test",
				server(api) {
					api.action({ id: "do_thing", label: "Do thing", async plan() {} });
				},
			}),
		]);

		expect(registry.getAction("test_process", "do_thing")).toBeDefined();
		expect(registry.getAction("test_process", "nonexistent")).toBeUndefined();
		expect(registry.getAction("unknown_process", "do_thing")).toBeUndefined();
	});

	it("does not surface standalone actions absent from the selected human turn", () => {
		const registry = buildRegistry([
			makeProcess({
				id: "test_process",
				displayName: "Test",
				server(api) {
					api.action({ id: "do_thing", label: "Do thing", async plan() {} });
				},
			}),
		]);

		expect(
			registry.listVisibleActions("test_process", createVisibilityCtx(makeFakeAgent())),
		).toEqual([]);
	});

	it("derives human-turn action visibility from the current turn without action-level mapping", () => {
		const registry = buildRegistry([
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
			}),
		]);

		expect(registry.isTurnScopedAction("ticket_issue_process", "approve_plan")).toBe(true);
		expect(registry.isTurnScopedAction("ticket_issue_process", "request_revision")).toBe(true);
		expect(registry.isTurnScopedAction("ticket_issue_process", "handoff_review")).toBe(false);
		expect(
			registry.listVisibleActions("ticket_issue_process", createVisibilityCtx(makeFakeAgent(), {})),
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
		const registry = buildRegistry([
			makeProcess({
				server(api) {
					api.action({
						id: "approve_plan",
						label: "Approve",
						preview: { kind: "terminal", lifecycleStatus: "aborted" },
						scheduling: { preview: { kind: "terminal", lifecycleStatus: "aborted" } },
						plan: async () => {
							throw new Error("Preview must not execute the action");
						},
					});
				},
				turns: {
					plan_review: createPlanReviewTurn({
						actions: {
							approve_plan: {
								label: "Approve plan",
								acceptanceState: "accepted",
								trigger: "plan_approved",
								to: "implement",
								preview: { kind: "trigger", trigger: "plan_approved" },
								schedulable: true,
							},
						},
					}),
				},
			}),
		]);
		const process = makeFakeAgent();

		expect(
			registry.resolveActionPreview("ticket_issue_process", process, "approve_plan"),
		).toMatchObject({
			candidateSelectedTurnId: "implement",
			lifecycleStatus: null,
		});
		expect(
			registry.resolveActionScheduling("ticket_issue_process", process, "approve_plan"),
		).toEqual({
			definition: { preview: { kind: "trigger", trigger: "plan_approved" } },
			candidateSelectedTurnId: "implement",
			lifecycleStatus: null,
		});
	});

	it.each([
		false,
		true,
	])("resolves unschedulable action previews (side effect: %s)", (sideEffect) => {
		const registry = buildRegistry([
			makeProcess({
				server(api) {
					api.action({
						id: "approve_plan",
						label: "Approve",
						plan: async () => {},
						...(sideEffect
							? { executionMode: "side_effect" as const, execute: async () => {} }
							: {}),
					});
				},
				turns: {
					plan_review: createPlanReviewTurn({
						actions: {
							approve_plan: {
								label: "Approve plan",
								acceptanceState: "accepted",
								description: "Approve the saved plan and continue.",
								trigger: "plan_approved",
								to: "implement",
								preview: { kind: "trigger", trigger: "plan_approved" },
							},
						},
					}),
				},
			}),
		]);
		const process = makeFakeAgent();
		expect(
			registry.resolveActionScheduling("ticket_issue_process", process, "approve_plan"),
		).toBeNull();

		expect(registry.resolveActionPreview("ticket_issue_process", process, "approve_plan")).toEqual({
			definition: { kind: "trigger", trigger: "plan_approved" },
			candidateSelectedTurnId: "implement",
			lifecycleStatus: null,
		});
		expect(
			registry.listVisibleActions("ticket_issue_process", createVisibilityCtx(process, {})),
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

	it.each([
		[
			{ kind: "fixed_turn", turnId: "implement" },
			{ candidateSelectedTurnId: "implement", lifecycleStatus: null },
		],
		[
			{ kind: "fixed_turn", turnId: null },
			{ candidateSelectedTurnId: null, lifecycleStatus: null },
		],
		[
			{ kind: "terminal", lifecycleStatus: "completed" },
			{ candidateSelectedTurnId: null, lifecycleStatus: "completed" },
		],
		[
			{ kind: "trigger", trigger: "approve_plan" },
			{ candidateSelectedTurnId: null, lifecycleStatus: "completed" },
		],
		[{ kind: "trigger", trigger: "unknown" }, null],
	] as const)("resolves server preview and scheduling targets for %j", (preview, target) => {
		const registry = buildRegistry([
			makeProcess({
				server(api) {
					api.action({
						id: "inspect",
						label: "Inspect",
						scheduling: { preview },
						plan: async () => {
							throw new Error("Preview must not execute the action");
						},
					});
				},
			}),
		]);
		const process = makeFakeAgent();
		expect(registry.resolveActionPreview("ticket_issue_process", process, "inspect")).toEqual(
			target ? { definition: preview, ...target } : null,
		);
		expect(registry.resolveActionScheduling("ticket_issue_process", process, "inspect")).toEqual(
			target ? { definition: { preview }, ...target } : null,
		);
	});

	it("resolves UI human-turn actions from the selected turn", () => {
		const registry = buildRegistry([
			makeProcess({
				turns: {
					implementation_review: humanTurn({
						description: "Review the implementation",
						reviewSemanticRef: "review",
						actions: {
							accept_change: { label: "Accept", acceptanceState: "accepted", complete: true },
							apply_review: {
								label: "Revise",
								acceptanceState: "requires_changes",
								complete: true,
							},
						},
					}),
				},
			}),
		]);
		const planProcess = makeFakeAgent();
		const implementationProcess = createImplementationReviewProcess();

		expect(
			registry.resolveTurnScopedAction("ticket_issue_process", planProcess, "approve_plan", "ui"),
		).toMatchObject({
			kind: "ui_human_action",
			turnId: "plan_review",
			turnType: "human",
			acceptanceState: "accepted",
			semanticEntryRefKey: "plan",
		});
		expect(
			registry.resolveTurnScopedAction(
				"ticket_issue_process",
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
			registry.resolveTurnScopedAction("ticket_issue_process", planProcess, "accept_change", "ui"),
		).toBeNull();
	});

	it("exposes external trigger summaries for the selected human turn", () => {
		const registry = buildRegistry([
			makeProcess({
				id: "poem_creator_process",
				entry: "poem_review",
				turns: {
					poem_review: humanTurn({
						description: "Review the poem",
						commentary: "Review the poem or trigger a revision externally.",
						actions: {
							request_poem_revision: {
								label: "Request poem revision",
								acceptanceState: "requires_changes",
								complete: true,
								externalTriggers: [
									{
										id: "poem_review_file",
										label: "Configured poem review file",
										description: "Write revision feedback to the poem review trigger file.",
									},
								],
							},
						},
					}),
				},
			}),
		]);
		const process = makeFakeAgent({
			processId: "poem_creator_process",
			selectedTurnId: "poem_review",
			lifecycleStatus: "waiting",
			stateJson: JSON.stringify({}),
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
			acceptanceState: "requires_changes",
			externalTrigger: { id: "poem_review_file", actionId: "request_poem_revision" },
		});
	});

	it("surfaces automatic selected turns as leitwerk-owned steps", () => {
		const registry = buildRegistry([
			makeProcess({
				id: "automatic_process",
				entry: "commit_and_merge",
				turns: {
					commit_and_merge: {
						...createFixtureAutomaticTurn("Commit and merge"),
						waitFor: () => false,
						externalActions: {
							change_merged: {
								id: "change_merged",
								source: {
									kind: "example.change.merged",
									label: "Change merged",
									description: "Continue after the external change merges.",
									config: {},
								},
								to: "commit_and_merge",
							},
							private_pipeline_failed: {
								id: "private_pipeline_failed",
								source: {
									kind: "example.pipeline.failed",
									label: "Private pipeline failed",
									description: "Repair the private pipeline.",
									config: {},
								},
								when: ({ state }) => (state as { scope?: string }).scope !== "public-only",
								to: "commit_and_merge",
							},
						},
					},
				},
			}),
		]);
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

		const waitingProcess = makeFakeAgent({
			processId: "automatic_process",
			selectedTurnId: "commit_and_merge",
			lifecycleStatus: "waiting",
			stateJson: JSON.stringify({ scope: "public-only" }),
		});
		expect(registry.getSelectedTurnSummary("automatic_process", waitingProcess)).toEqual({
			turnId: "commit_and_merge",
			kind: "automatic",
			description: "Commit and merge",
			commentary: null,
			externalTriggers: [
				{
					id: "commit_and_merge:change_merged",
					externalActionId: "change_merged",
					kind: "example.change.merged",
					sourceKind: "example.change.merged",
					label: "Change merged",
					description: "Continue after the external change merges.",
				},
			],
		});
	});

	it("resolves selected external turns without UI actions", () => {
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

		const registry = buildRegistry([
			makeProcess({
				id: "single_prompt_external_complete_process",
				entry: "await_external_prompt_completion",
				turns: { await_external_prompt_completion: externalCompletionTurn.definition },
			}),
		]);
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
		const registry = buildRegistry([
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
		]);
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
		const registry = buildRegistry([
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
		]);
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
		const registry = buildRegistry([
			makeProcess({
				server(api) {
					api.action({
						id: "handoff_review",
						label: "Handoff review",
						async plan(_input, ctx) {
							await ctx.transition({
								turnId: "run_llm_review",
								state: {},
								effect: { runtime: "restart_worker" },
							});
						},
					});
				},
			}),
		]);
		const planned = await collectPlan(process, registry, "handoff_review");

		expect("ok" in planned).toBe(false);
		if ("ok" in planned) return;
		expect(planned.workerIntent).toEqual({ kind: "restart_worker" });
		expect(planned.metadata).toBeUndefined();
	});
});
