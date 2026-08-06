import {
	type createServerProcessBuilder,
	defineProcess,
	flow,
	humanTurn,
	llmTurn,
} from "@leitwerk-dev/process-sdk";
import { describe, expect, it } from "vitest";
import { buildProcessActionRegistry } from "./process-action-registry.js";
import { buildProcessAttentionToast } from "./process-operator-attention.js";
import { createTestDeps } from "./test-helpers/unit-deps.js";

function createProcess(server: (api: ReturnType<typeof createServerProcessBuilder>) => void) {
	return defineProcess({
		id: "test_process",
		displayName: "Test Process",
		entry: "generate_plan",
		paramsCodec: { parse: () => ({}), serialize: (value: unknown) => value },
		stateCodec: { parse: () => ({}), serialize: (value: unknown) => value },
		initialState: () => ({}),
		turns: {
			generate_plan: llmTurn({
				availableTools: [],
				description: "Generate the plan",
				branchType: "primary",
				context: "fresh",
				prompt: async () => "Generate plan",
				outcomes: {
					plan_saved: { description: "saved", parameters: {}, to: "plan_review" },
				},
			}),
			plan_review: humanTurn({
				description: "Review the generated plan",
				reviewSubject: { kind: "plan" },
				actions: {
					approve_plan: {
						label: "Approve plan",
						acceptanceState: "accepted",
						to: "generate_plan",
						trigger: "plan_approved",
					},
				},
			}),
			await_external_prompt_completion: flow
				.external("await_external_prompt_completion")
				.description("Wait for an external completion trigger")
				.from({
					kind: "example.file.presence",
					label: "Prompt-complete file",
					description: "Write to the prompt-complete trigger file.",
					config: {},
				})
				.complete().definition,
			command_console: humanTurn({
				description: "Passive command console",
				operatorAttention: "passive",
				actions: {
					run_command: {
						label: "Run command",
						acceptanceState: "neutral",
						to: "command_console",
					},
				},
			}),
		},
		server,
	});
}

const testProcess = createProcess(() => {});

const processGraphs = new Map([[testProcess.id, testProcess]]);

const processActionRegistry = buildProcessActionRegistry({
	processes: new Map([["test_process", testProcess]]),
});

describe("buildProcessAttentionToast", () => {
	it("builds an action-required toast when a waiting process has visible actions", () => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "test_process",
			selectedTurnId: "plan_review",
			lifecycleStatus: "waiting",
			title: "PROJ-123",
		});

		const toast = buildProcessAttentionToast(
			{
				projects: deps.projects,
				futureExecutions: deps.futureExecutions,
				turnRecords: deps.turnRecords,
				turnStarts: deps.turnStarts,
				processGraphs,
				processActionRegistry,
			},
			{ process, kind: "action_required" },
		);

		expect(toast).toMatchObject({
			level: "warn",
			eventType: "action_required",
			message: "PROJ-123 · Review the generated plan needs a decision",
			dedupeKey: `${process.id}:action_required:plan_review`,
		});
	});

	it("suppresses action-required toasts for external-trigger-only waiting states", () => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "test_process",
			selectedTurnId: "await_external_prompt_completion",
			lifecycleStatus: "waiting",
			title: "PROJ-456",
		});

		const toast = buildProcessAttentionToast(
			{
				projects: deps.projects,
				futureExecutions: deps.futureExecutions,
				turnRecords: deps.turnRecords,
				turnStarts: deps.turnStarts,
				processGraphs,
				processActionRegistry,
			},
			{ process, kind: "action_required" },
		);

		expect(toast).toBeNull();
	});

	it("suppresses action-required toasts for passive human turns", () => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "test_process",
			selectedTurnId: "command_console",
			lifecycleStatus: "waiting",
			title: "Local shell",
		});

		const toast = buildProcessAttentionToast(
			{
				projects: deps.projects,
				futureExecutions: deps.futureExecutions,
				turnRecords: deps.turnRecords,
				turnStarts: deps.turnStarts,
				processGraphs,
				processActionRegistry,
			},
			{ process, kind: "action_required" },
		);

		expect(toast).toBeNull();
	});

	it("suppresses action-required toasts when a scheduled action locks the process", () => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "test_process",
			selectedTurnId: "plan_review",
			lifecycleStatus: "waiting",
			title: "PROJ-789",
		});
		deps.futureExecutions.create({
			kind: "action",
			scheduleKind: "once",
			processId: process.processId,
			instanceId: process.id,
			actionId: "approve_plan",
			payloadJson: JSON.stringify({ input: {}, actionLabel: "Approve plan" }),
			nextRunAt: "2026-04-30T12:00:00.000Z",
		});

		const toast = buildProcessAttentionToast(
			{
				projects: deps.projects,
				futureExecutions: deps.futureExecutions,
				turnRecords: deps.turnRecords,
				turnStarts: deps.turnStarts,
				processGraphs,
				processActionRegistry,
			},
			{ process, kind: "action_required" },
		);

		expect(toast).toBeNull();
	});

	it("builds a failed-step toast when recovery is required", () => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "test_process",
			selectedTurnId: "generate_plan",
			lifecycleStatus: "error",
			title: "PROJ-999",
		});
		deps.turnRecords.create({
			id: "trn_failed",
			instanceId: process.id,
			turnId: "generate_plan",
			turnType: "llm",
			status: "failed",
			pathType: "primary",
		});
		const failedProcess = deps.processes.getById(process.id);
		if (!failedProcess) throw new Error("Fixture process was not persisted");

		const toast = buildProcessAttentionToast(
			{
				projects: deps.projects,
				futureExecutions: deps.futureExecutions,
				turnRecords: deps.turnRecords,
				turnStarts: deps.turnStarts,
				processGraphs,
				processActionRegistry,
			},
			{ process: failedProcess, kind: "error" },
		);

		expect(toast).toMatchObject({
			level: "error",
			eventType: "turn_failed",
			message: "PROJ-999 · Generate the plan failed and needs recovery",
			dedupeKey: `${process.id}:turn_failed:trn_failed`,
		});
	});

	it("falls back to a worker-failure toast when no failed turn record exists", () => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "test_process",
			selectedTurnId: "plan_review",
			lifecycleStatus: "error",
			title: "PROJ-321",
		});

		const toast = buildProcessAttentionToast(
			{
				projects: deps.projects,
				futureExecutions: deps.futureExecutions,
				turnRecords: deps.turnRecords,
				turnStarts: deps.turnStarts,
				processGraphs,
				processActionRegistry,
			},
			{ process, kind: "error", errorCode: "startup_timeout" },
		);

		expect(toast).toMatchObject({
			level: "error",
			eventType: "worker_failed",
			message: "PROJ-321 · Review the generated plan needs attention",
			dedupeKey: `${process.id}:worker_failed:plan_review:startup_timeout`,
		});
	});
});
