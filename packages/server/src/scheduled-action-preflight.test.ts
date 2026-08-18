import {
	defineProcess,
	humanTurn,
	llmTurn,
	type ProcessActionDefinition,
} from "@leitwerk-dev/process-sdk";
import { describe, expect, it } from "vitest";
import { buildProcessActionRegistry } from "./process-action-registry.js";
import { preflightScheduledActionRequest } from "./scheduled-action-preflight.js";
import { createDefaultTestProcessGraphRegistry } from "./test-helpers/process-fixtures.js";
import { createTestDeps } from "./test-helpers/unit-deps.js";

const processGraphs = createDefaultTestProcessGraphRegistry();
function buildRegistry(
	action: ProcessActionDefinition,
	options: { includeScheduling?: boolean } = {},
) {
	const process = defineProcess<Record<string, never>, Record<string, unknown>>({
		id: "ticket_issue_process",
		displayName: "Implement Ticket Issue",
		entry: "plan_review",
		paramsCodec: { parse: () => ({}), serialize: (value) => value },
		stateCodec: {
			parse: (value) => (value ?? {}) as Record<string, unknown>,
			serialize: (value) => value,
		},
		initialState: () => ({}),
		turns: {
			plan_review: humanTurn({
				description: "Review the plan",
				actions: {
					[action.id]: {
						label: action.label,
						acceptanceState: "accepted",
						trigger: "plan_approved",
						to: "implement",
						preview: { kind: "trigger", trigger: "plan_approved" },
						...((options.includeScheduling ?? true) ? { schedulable: true } : {}),
					},
				},
			}),
			implement: llmTurn({
				availableTools: [],
				description: "Implement",
				completionMode: "turn_end",
				branchType: "primary",
				context: "full",
				prompt: async () => "implement",
				turnEnd: { outcome: "done", params: {}, complete: true },
			}),
		},
	});
	process.server = (api) => {
		api.action(action);
	};
	return buildProcessActionRegistry({
		processes: new Map([["ticket_issue_process", process]]),
	});
}

function createPlanReviewProcess(deps = createTestDeps()) {
	return deps.processes.create({
		processId: "ticket_issue_process",
		selectedTurnId: "plan_review",
		lifecycleStatus: "waiting",
		stateJson: JSON.stringify({}),
	});
}

describe("preflightScheduledActionRequest", () => {
	it("uses the pure plan hook without running an execute hook", async () => {
		const deps = createTestDeps();
		let executed = 0;
		const registry = buildRegistry({
			id: "approve_plan",
			label: "Approve plan",
			plan: async (_input, ctx) => {
				await ctx.transition({ turnId: "implement", trigger: "plan_approved" });
			},
			execute: async () => {
				executed += 1;
			},
		});
		const process = createPlanReviewProcess();

		const result = await preflightScheduledActionRequest({
			processGraphs,
			processActionRegistry: registry,
			process,
			projects: [],
			turnRecords: deps.turnRecords,
			actionId: "approve_plan",
			actionInput: {},
		});

		expect(result.ok).toBe(true);
		expect(executed).toBe(0);
	});

	it("validates required form fields before scheduling", async () => {
		const deps = createTestDeps();
		let executed = 0;
		const registry = buildRegistry({
			id: "request_revision",
			label: "Request revision",
			form: {
				id: "request_revision",
				title: "Request revision",
				fields: [{ id: "message", label: "Message", kind: "textarea", required: true }],
			},
			plan: async (_input, ctx) => {
				await ctx.transition({ turnId: "implement", trigger: "plan_approved" });
			},
			execute: async () => {
				executed += 1;
			},
		});
		const process = createPlanReviewProcess();

		const result = await preflightScheduledActionRequest({
			processGraphs,
			processActionRegistry: registry,
			process,
			projects: [],
			turnRecords: deps.turnRecords,
			actionId: "request_revision",
			actionInput: {},
		});

		expect(result).toEqual({
			ok: false,
			code: "invalid_action_input",
			error: "Field 'message' is required",
		});
		expect(executed).toBe(0);
	});

	it("rejects scheduling for actions without declarative scheduling support", async () => {
		const deps = createTestDeps();
		const registry = buildRegistry(
			{
				id: "approve_plan",
				label: "Approve plan",
				plan: async () => {},
			},
			{ includeScheduling: false },
		);
		const process = createPlanReviewProcess();

		const result = await preflightScheduledActionRequest({
			processGraphs,
			processActionRegistry: registry,
			process,
			projects: [],
			turnRecords: deps.turnRecords,
			actionId: "approve_plan",
			actionInput: {},
		});

		expect(result).toEqual({
			ok: false,
			code: "action_not_schedulable",
			error: "Action 'approve_plan' does not support scheduling",
		});
	});

	it("rejects schedulable actions that do not declare a pure plan hook", async () => {
		const deps = createTestDeps();
		const registry = buildRegistry({
			id: "approve_plan",
			label: "Approve plan",
			executionMode: "side_effect",
			execute: async () => {},
		});
		const process = createPlanReviewProcess();

		const result = await preflightScheduledActionRequest({
			processGraphs,
			processActionRegistry: registry,
			process,
			projects: [],
			turnRecords: deps.turnRecords,
			actionId: "approve_plan",
			actionInput: {},
		});

		expect(result).toEqual({
			ok: false,
			code: "action_not_schedulable",
			error: "Action 'approve_plan' does not support scheduling",
		});
	});

	it("passes persisted semantic markdown through scheduling preflight", async () => {
		const deps = createTestDeps();
		const registry = buildRegistry({
			id: "request_revision",
			label: "Request revision",
			plan: async (_input, ctx) => {
				expect(ctx.readSemanticTurnResultMarkdown("plan")).toBe("# Candidate plan");
				await ctx.transition({ turnId: "implement", trigger: "plan_approved" });
			},
		});
		const process = deps.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "plan_review",
			lifecycleStatus: "waiting",
			stateJson: JSON.stringify({
				semanticEntryRefs: {
					rootEntry: null,
					currentPrimaryPathLeaf: null,
					plan: { entryId: "plan-entry", turnRecordId: "trn_plan_1" },
					review: null,
				},
			}),
		});
		deps.turnRecords.create({
			id: "trn_plan_1",
			instanceId: process.id,
			turnId: "generate_plan",
			turnType: "llm",
			status: "succeeded",
			pathType: "primary",
			resultPiEntryId: "plan-entry",
			turnResultMarkdown: "# Candidate plan",
			startedAt: "2026-04-30T11:59:00.000Z",
			endedAt: "2026-04-30T12:00:00.000Z",
		});

		const result = await preflightScheduledActionRequest({
			processGraphs,
			processActionRegistry: registry,
			process,
			projects: [],
			turnRecords: deps.turnRecords,
			actionId: "request_revision",
			actionInput: {},
		});

		expect(result.ok).toBe(true);
	});
});
