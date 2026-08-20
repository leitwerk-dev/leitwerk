import { defineProcess, type ProcessActionDefinition } from "@leitwerk-dev/process-sdk";
import { describe, expect, it } from "vitest";
import { planProcessAction } from "./process-action-planner.js";
import { buildProcessActionRegistry } from "./process-action-registry.js";
import { createDefaultTestProcessGraphRegistry } from "./test-helpers/process-fixtures.js";
import { createTestDeps } from "./test-helpers/unit-deps.js";

const processGraphs = createDefaultTestProcessGraphRegistry();
function buildRegistry(action: ProcessActionDefinition) {
	return buildProcessActionRegistry({
		processes: new Map([
			[
				"ticket_issue_process",
				defineProcess({
					id: "ticket_issue_process",
					displayName: "Implement Ticket Issue",
					entry: "plan_review",
					turns: {
						plan_review: {
							description: "Review the plan",
							kind: "human" as const,
							actions: {
								approve_plan_turn_route: {
									label: "Approve plan",
									acceptanceState: "accepted" as const,
									preview: { kind: "trigger" as const, trigger: "plan_approved" },
									schedulable: true,
									trigger: "plan_approved",
									to: "implement",
								},
							},
						},
						implement: {
							description: "Implement",
							kind: "llm" as const,
							completionMode: "turn_end" as const,
							branchType: "primary" as const,
							context: "full" as const,
							prompt: async () => "implement",
							turnEnd: { outcome: "done", params: {}, complete: true },
						},
					},
					paramsCodec: { parse: () => ({}), serialize: (value: unknown) => value },
					stateCodec: {
						parse: (value: unknown) => (value ?? {}) as Record<string, unknown>,
						serialize: (value: unknown) => value,
					},
					initialState: () => ({}),
					server(api) {
						api.action(action);
					},
				}),
			],
		]),
	});
}

function createPlanReviewProcess() {
	const deps = createTestDeps();
	return deps.processes.create({
		processId: "ticket_issue_process",
		selectedTurnId: "plan_review",
		lifecycleStatus: "waiting",
		stateJson: JSON.stringify({}),
	});
}

describe("planProcessAction", () => {
	it("uses the shared pure plan hook to derive the candidate next turn", async () => {
		const registry = buildRegistry({
			id: "approve_plan",
			label: "Approve plan",
			preview: { kind: "fixed_turn", turnId: "plan_review" },
			plan: async (_input, ctx) => {
				await ctx.transition({ turnId: "implement", trigger: "plan_approved" });
			},
			execute: async () => {
				throw new Error("execute should not run for pure planning");
			},
		});
		const process = createPlanReviewProcess();

		const result = await planProcessAction({
			processGraphs,
			processActionRegistry: registry,
			process,
			projects: [],
			turnRecords: { getById: () => null },
			actionId: "approve_plan",
			actionInput: {},
			requirePurePlan: true,
		});

		expect(result).toMatchObject({ ok: true, candidateSelectedTurnId: "implement" });
	});

	it("falls back to the current selected turn when the pure plan does not change turns", async () => {
		const registry = buildRegistry({
			id: "approve_plan",
			label: "Approve plan",
			plan: async (_input, ctx) => {
				ctx.queueInput({
					source: "action_prompt",
					kind: "instruction",
					bodyMarkdown: "Keep going",
					target: { semanticRef: "currentPrimaryPathLeaf" },
				});
			},
		});
		const process = createPlanReviewProcess();

		const result = await planProcessAction({
			processGraphs,
			processActionRegistry: registry,
			process,
			projects: [],
			turnRecords: { getById: () => null },
			actionId: "approve_plan",
			actionInput: {},
			requirePurePlan: true,
		});

		expect(result).toMatchObject({ ok: true, candidateSelectedTurnId: "plan_review" });
		if (!result.ok) return;
		expect(result.writes.queuedInputs).toHaveLength(1);
	});

	it("rejects pure planning when the action only declares execute", async () => {
		const registry = buildRegistry({
			id: "approve_plan",
			label: "Approve plan",
			executionMode: "side_effect",
			execute: async () => {},
		});
		const process = createPlanReviewProcess();

		const result = await planProcessAction({
			processGraphs,
			processActionRegistry: registry,
			process,
			projects: [],
			turnRecords: { getById: () => null },
			actionId: "approve_plan",
			actionInput: {},
			requirePurePlan: true,
		});

		expect(result).toMatchObject({ ok: false, code: "action_failed" });
	});
});
