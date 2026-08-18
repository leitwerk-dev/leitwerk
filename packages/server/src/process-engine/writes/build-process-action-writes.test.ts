import type { ProcessActionDefinition } from "@leitwerk-dev/process-sdk";
import { describe, expect, it } from "vitest";
import { createDefaultTestProcessGraphRegistry } from "../../test-helpers/process-fixtures.js";
import { createTestDeps } from "../../test-helpers/unit-deps.js";
import {
	collectProcessActionPlan,
	collectPureProcessActionPlan,
} from "./build-process-action-writes.js";

const processGraphs = createDefaultTestProcessGraphRegistry();

describe("collectProcessActionPlan", () => {
	it("collects queued inputs, deferred extension events, and explicit transition effects", async () => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "handoff_review",
			lifecycleStatus: "active",
		});
		const action: ProcessActionDefinition = {
			id: "handoff_review",
			label: "Handoff review",
			async plan(_input, ctx) {
				ctx.queueInput({
					source: "app_steer",
					kind: "instruction",
					bodyMarkdown: "Please watch for follow-up review comments.",
				});
				ctx.emitEvent("plan_revision_requested", {
					message: "Need human review context in the handoff.",
				});
				await ctx.transition({
					turnId: "run_llm_review",
					state: {},
					effect: { runtime: "restart_worker" },
				});
			},
		};

		const planned = await collectProcessActionPlan({
			process,
			projects: [],
			params: {},
			state: {},
			turnRecords: deps.turnRecords,
			processGraphs,
			action,
			input: {},
			isVisible: true,
		});

		expect("ok" in planned).toBe(false);
		if ("ok" in planned) return;
		expect(planned.queuedInputs).toEqual([
			{
				source: "app_steer",
				kind: "instruction",
				target: null,
				bodyMarkdown: "Please watch for follow-up review comments.",
			},
		]);
		expect(planned.extensionEvents).toEqual([
			{
				type: "plan_revision_requested",
				payload: {
					instanceId: process.id,
					message: "Need human review context in the handoff.",
				},
			},
		]);
		expect(planned.processPatch).toMatchObject({
			selectedTurnId: "run_llm_review",
			stateJson: JSON.stringify({}),
		});
		expect(planned.workerIntent).toEqual({ kind: "restart_worker" });
	});

	it("accepts externally-resolved action visibility for reusable human-turn actions", async () => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "plan_review",
			lifecycleStatus: "waiting",
		});
		const action: ProcessActionDefinition = {
			id: "approve_plan",
			label: "Approve plan",
			async plan(_input, ctx) {
				await ctx.transition({ turnId: "implement", trigger: "plan_approved" });
			},
		};

		const planned = await collectProcessActionPlan({
			process,
			projects: [],
			params: {},
			state: {},
			turnRecords: deps.turnRecords,
			processGraphs,
			action,
			input: {},
			isVisible: true,
		});

		expect("ok" in planned).toBe(false);
		if ("ok" in planned) return;
		expect(planned.processPatch.selectedTurnId).toBe("implement");
	});

	it("reads persisted semantic-ref markdown for action-authored follow-up inputs", async () => {
		const deps = createTestDeps();
		const reviewMarkdown = "## Review\n\nTighten the rollout steps.";
		const process = deps.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "plan_review_feedback",
			lifecycleStatus: "waiting",
			stateJson: JSON.stringify({
				semanticEntryRefs: {
					review: { entryId: "ent_review", turnRecordId: "trn_review" },
				},
			}),
		});
		deps.turnRecords.create({
			id: "trn_review",
			instanceId: process.id,
			turnId: "review_plan",
			status: "succeeded",
			pathType: "root_branch",
			resultPiEntryId: "ent_review",
			turnResultMarkdown: reviewMarkdown,
			endedAt: new Date().toISOString(),
		});
		const action: ProcessActionDefinition = {
			id: "accept_review",
			label: "Accept review",
			async plan(_input, ctx) {
				const markdown = ctx.readSemanticTurnResultMarkdown("review");
				if (!markdown) {
					throw new Error("Expected review markdown");
				}
				ctx.queueInput({
					source: "action_prompt",
					kind: "instruction",
					target: { semanticRef: "currentPrimaryPathLeaf" },
					bodyMarkdown: markdown,
				});
			},
		};

		const planned = await collectProcessActionPlan({
			process,
			projects: [],
			params: {},
			state: {},
			turnRecords: deps.turnRecords,
			processGraphs,
			action,
			input: {},
			isVisible: true,
		});

		expect("ok" in planned).toBe(false);
		if ("ok" in planned) return;
		expect(planned.queuedInputs).toEqual([
			{
				source: "action_prompt",
				kind: "instruction",
				target: { semanticRef: "currentPrimaryPathLeaf" },
				bodyMarkdown: reviewMarkdown,
			},
		]);
	});

	it("fails when a semantic ref points at a missing turn record", async () => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "plan_review_feedback",
			lifecycleStatus: "waiting",
			stateJson: JSON.stringify({
				semanticEntryRefs: {
					review: { entryId: "ent_review", turnRecordId: "trn_missing" },
				},
			}),
		});
		const action: ProcessActionDefinition = {
			id: "accept_review",
			label: "Accept review",
			async plan(_input, ctx) {
				ctx.readSemanticTurnResultMarkdown("review");
			},
		};

		const planned = await collectProcessActionPlan({
			process,
			projects: [],
			params: {},
			state: {},
			turnRecords: deps.turnRecords,
			processGraphs,
			action,
			input: {},
			isVisible: true,
		});

		expect(planned).toMatchObject({
			ok: false,
			code: "action_failed",
		});
		if (!("ok" in planned)) return;
		expect(planned.error).toContain("references missing turn record");
	});

	it("rejects actions that are not visible in the current state", async () => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "generate_plan",
			lifecycleStatus: "active",
		});
		const action: ProcessActionDefinition = {
			id: "hidden_action",
			label: "Hidden action",
			async plan() {},
		};

		const planned = await collectProcessActionPlan({
			process,
			projects: [],
			params: {},
			state: {},
			turnRecords: deps.turnRecords,
			processGraphs,
			action,
			input: {},
			isVisible: false,
		});

		expect(planned).toEqual({
			ok: false,
			code: "action_not_visible",
			error: "Action 'hidden_action' is not available in the current state",
		});
	});

	it("uses the pure plan hook instead of an execute hook when available", async () => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "plan_review",
			lifecycleStatus: "waiting",
		});
		let executeCalls = 0;
		const action: ProcessActionDefinition = {
			id: "approve_plan",
			label: "Approve plan",
			async plan(_input, ctx) {
				await ctx.transition({ turnId: "implement", trigger: "plan_approved" });
			},
			async execute() {
				executeCalls += 1;
			},
		};

		const planned = await collectPureProcessActionPlan({
			process,
			projects: [],
			params: {},
			state: {},
			turnRecords: deps.turnRecords,
			processGraphs,
			action,
			input: {},
			isVisible: true,
		});

		expect("ok" in planned).toBe(false);
		if ("ok" in planned) return;
		expect(planned.processPatch.selectedTurnId).toBe("implement");
		expect(executeCalls).toBe(0);
	});

	it("rejects pure planning when the action only declares execute", async () => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "plan_review",
			lifecycleStatus: "waiting",
		});
		const action: ProcessActionDefinition = {
			id: "approve_plan",
			label: "Approve plan",
			executionMode: "side_effect",
			async execute(_input, ctx) {
				await ctx.transition({ turnId: "implement", trigger: "plan_approved" });
			},
		};

		const planned = await collectPureProcessActionPlan({
			process,
			projects: [],
			params: {},
			state: {},
			turnRecords: deps.turnRecords,
			processGraphs,
			action,
			input: {},
			isVisible: true,
		});

		expect(planned).toMatchObject({
			ok: false,
			code: "action_failed",
		});
		if (!("ok" in planned)) return;
		expect(planned.error).toContain("pure plan");
	});
});
