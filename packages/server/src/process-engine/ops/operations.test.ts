import { describe, expect, it } from "vitest";
import type { ProcessActionRegistry } from "../../process-action-registry.js";
import { createProcessOperationCoordinator } from "../../process-operation-coordinator.js";
import {
	createDefaultTestProcessGraphRegistry,
	createFixtureLlmTurn,
	createFixtureProcess,
	createProcessGraphRegistry,
} from "../../test-helpers/process-fixtures.js";
import { createTestDeps } from "../../test-helpers/unit-deps.js";
import type { DecideContext, ProcessEngineDeps } from "../types.js";
import {
	AbortProcess,
	ContinueFailedTurn,
	ExecuteAction,
	ParkProcess,
	QueueInputs,
	RetryFailedTurn,
	StartProcess,
	TurnFailed,
	TurnOutcome,
	UpdateProductRefs,
	UpdateSemanticRefs,
	WorkerFailure,
} from "./index.js";

function createDeps(): ProcessEngineDeps {
	const deps = createTestDeps();
	return {
		...deps,
		processOperations: createProcessOperationCoordinator(),
		getSupervisor: () => undefined,
		processGraphs: createDefaultTestProcessGraphRegistry(),
	};
}

function ctx(deps: ProcessEngineDeps, instanceId: string): DecideContext {
	const process = deps.processes.getById(instanceId);
	if (!process) {
		throw new Error(`Missing process ${instanceId}`);
	}
	return { deps, instanceId, process };
}

describe("ProcessEngine operation decisions", () => {
	it("StartProcess decides a selected-turn write", async () => {
		const deps = createDeps();
		const process = deps.processes.create({ processId: "ticket_issue_process" });

		const decision = await StartProcess.decide(ctx(deps, process.id), {
			instanceId: process.id,
			startTurnId: "generate_plan",
		});

		expect(decision.ok).toBe(true);
		if (!decision.ok) return;
		expect(decision.writes.processPatch).toMatchObject({
			selectedTurnId: "generate_plan",
			lifecycleStatus: "error",
			currentExecution: { kind: "worker_start" },
		});
		expect(decision.writes.turnStartWrites).toEqual([
			expect.objectContaining({
				kind: "create",
				input: expect.objectContaining({
					state: expect.objectContaining({ kind: "preparation_failed", code: "model_required" }),
				}),
			}),
		]);
	});

	it("AbortProcess atomically plans scheduled-action cleanup", async () => {
		const deps = createDeps();
		const process = deps.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "generate_plan",
			lifecycleStatus: "active",
		});
		deps.futureExecutions.create({
			id: "fut_abort_cleanup",
			kind: "action",
			scheduleKind: "once",
			processId: process.processId,
			instanceId: process.id,
			actionId: "approve",
			payloadJson: "{}",
			nextRunAt: "2099-01-01T00:00:00.000Z",
		});

		const decision = await AbortProcess.decide(ctx(deps, process.id), { instanceId: process.id });

		expect(decision.ok).toBe(true);
		if (!decision.ok) return;
		expect(decision.writes.futureExecutionPlans).toContainEqual({
			kind: "cancel_action",
			futureExecutionId: "fut_abort_cleanup",
			expectedInstanceId: process.id,
		});
	});

	it("RetryFailedTurn rejects when no failed turn record is available", async () => {
		const deps = createDeps();
		const process = deps.processes.create({
			processId: "ticket_issue_process",
			lifecycleStatus: "error",
		});

		const decision = await RetryFailedTurn.decide(ctx(deps, process.id), {
			instanceId: process.id,
		});

		expect(decision).toMatchObject({ ok: false, code: "retry_target_missing" });
	});

	it("ContinueFailedTurn rejects outside the error lifecycle", async () => {
		const deps = createDeps();
		const process = deps.processes.create({
			processId: "ticket_issue_process",
			lifecycleStatus: "active",
		});

		const decision = await ContinueFailedTurn.decide(ctx(deps, process.id), {
			instanceId: process.id,
			turnRecordId: "trn_missing",
		});

		expect(decision).toMatchObject({ ok: false, code: "invalid_transition" });
	});

	it("ContinueFailedTurn rejects failed turns without recovery metadata", async () => {
		const deps = createDeps();
		const process = deps.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "generate_plan",
			lifecycleStatus: "error",
		});
		deps.turnRecords.create({
			id: "trn_failed",
			instanceId: process.id,
			turnId: "generate_plan",
			turnType: "llm",
			status: "failed",
			pathType: "primary",
		});

		const decision = await ContinueFailedTurn.decide(ctx(deps, process.id), {
			instanceId: process.id,
			turnRecordId: "trn_failed",
		});

		expect(decision).toMatchObject({ ok: false, code: "invalid_transition" });
	});

	it("ParkProcess decides an error lifecycle write", async () => {
		const deps = createDeps();
		const process = deps.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "generate_plan",
			lifecycleStatus: "active",
		});

		const decision = await ParkProcess.decide(ctx(deps, process.id), {
			instanceId: process.id,
			payload: { reason: "operator requested park" },
		});

		expect(decision.ok).toBe(true);
		if (!decision.ok) return;
		expect(decision.writes.processPatch.lifecycleStatus).toBe("error");
	});

	it("WorkerFailure ignores duplicate parked failures without writes", async () => {
		const deps = createDeps();
		const process = deps.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "generate_plan",
			lifecycleStatus: "error",
		});
		deps.turnRecords.create({
			id: "trn_failed",
			instanceId: process.id,
			turnId: "generate_plan",
			status: "failed",
		});

		const decision = await WorkerFailure.decide(ctx(deps, process.id), {
			instanceId: process.id,
			payload: { errorCode: "process_exited", message: "Already failed" },
		});

		expect(decision.ok).toBe(true);
		if (!decision.ok) return;
		expect(decision.writes.changedFields).toEqual([]);
		expect(decision.writes.turnRecordWrites).toEqual([]);
	});

	it("TurnFailed rejects stale turn-record correlation", async () => {
		const deps = createDeps();
		const process = deps.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "generate_plan",
			lifecycleStatus: "active",
		});
		deps.turnRecords.create({
			id: "trn_current",
			instanceId: process.id,
			turnId: "generate_plan",
			turnType: "llm",
			status: "running",
			pathType: "primary",
		});

		const decision = await TurnFailed.decide(ctx(deps, process.id), {
			instanceId: process.id,
			payload: {
				instanceId: process.id,
				turnRecordId: "trn_stale",
				turnId: "generate_plan",
				turnType: "llm",
				pathType: "primary",
				errorSummary: "failed",
			},
		});

		expect(decision).toMatchObject({ ok: false, code: "stale_turn_record" });
	});

	it("QueueInputs rejects invalid targeted inputs", async () => {
		const deps = createDeps();
		const process = deps.processes.create({ processId: "ticket_issue_process" });

		const decision = await QueueInputs.decide(ctx(deps, process.id), {
			instanceId: process.id,
			queued: [
				{
					source: "app_steer",
					kind: "system_event",
					target: { semanticRef: "plan" },
					bodyMarkdown: "Invalid",
				},
			],
		});

		expect(decision).toMatchObject({ ok: false, code: "invalid_process_input" });
	});

	it("UpdateProductRefs decides a stateJson patch", async () => {
		const deps = createDeps();
		const process = deps.processes.create({ processId: "ticket_issue_process" });
		const decision = await UpdateProductRefs.decide(ctx(deps, process.id), {
			instanceId: process.id,
			patch: { "simplification-plan": { entryId: "turn-2", turnRecordId: null } },
		});

		expect(decision.ok).toBe(true);
		if (!decision.ok) return;
		expect(JSON.parse(decision.writes.processPatch.stateJson ?? "null")).toMatchObject({
			productRefs: {
				"simplification-plan": { entryId: "turn-2", turnRecordId: null },
			},
		});
	});

	it("UpdateSemanticRefs decides a stateJson patch", async () => {
		const deps = createDeps();
		const process = deps.processes.create({ processId: "ticket_issue_process" });

		const decision = await UpdateSemanticRefs.decide(ctx(deps, process.id), {
			instanceId: process.id,
			patch: { currentPrimaryPathLeaf: { entryId: "leaf_1", turnRecordId: "trn_1" } },
		});

		expect(decision.ok).toBe(true);
		if (!decision.ok) return;
		expect(decision.writes.processPatch.stateJson).toContain("leaf_1");
	});

	it("TurnOutcome rejects missing required turn-result markdown before applying an outcome", async () => {
		const deps = createDeps();
		const processDefinition = createFixtureProcess({
			id: "markdown_process",
			entry: "review",
			turns: {
				review: createFixtureLlmTurn("review", {
					turnEnd: undefined,
					outcomes: { done: { description: "Done", parameters: {}, complete: true } },
					turnResultMarkdown: {
						mode: "outcome_tool_argument",
						parameterName: "markdown",
						required: true,
					},
				}),
			},
		});
		const markdownDeps = {
			...deps,
			processGraphs: createProcessGraphRegistry([processDefinition]),
		};
		const process = markdownDeps.processes.create({
			processId: "markdown_process",
			selectedTurnId: "review",
			lifecycleStatus: "active",
		});
		markdownDeps.turnRecords.create({
			id: "trn_outcome",
			instanceId: process.id,
			turnId: "review",
			turnType: "llm",
			status: "running",
			pathType: "primary",
		});

		const decision = await TurnOutcome.decide(ctx(markdownDeps, process.id), {
			instanceId: process.id,
			payload: {
				instanceId: process.id,
				turnRecordId: "trn_outcome",
				turnId: "review",
				turnType: "llm",
				outcome: "done",
				params: {},
				pathType: "primary",
				resultPiEntryId: "entry_result",
				turnResultMarkdown: null,
			},
		});

		expect(decision).toMatchObject({ ok: false, code: "turn_result_markdown_missing" });
	});

	it("TurnOutcome requires an external receipt when process metadata opts in", async () => {
		const deps = createDeps();
		const processDefinition = createFixtureProcess({
			id: "receipt_process",
			entry: "create_external_item",
			turns: {
				create_external_item: createFixtureLlmTurn("Create external item", {
					turnEnd: undefined,
					outcomes: { created: { description: "Created", parameters: {}, complete: true } },
				}),
			},
		});
		const processActionRegistry = {
			getTurnDefinition: (_processId: string, turnId: string) =>
				processDefinition.turns.get(turnId)?.definition,
			getServerDefinition: () => undefined,
			resolveContextData: () => ({ params: {}, state: {} }),
		} as ProcessActionRegistry;
		const receiptDeps = {
			...deps,
			processGraphs: createProcessGraphRegistry([processDefinition]),
			getProcessActionRegistry: () => processActionRegistry,
		};
		const process = receiptDeps.processes.create({
			processId: processDefinition.id,
			selectedTurnId: "create_external_item",
			lifecycleStatus: "active",
			metadata: { _leitwerk: { requiresExternalReceipt: true } },
		});
		receiptDeps.turnRecords.create({
			id: "trn_receipt",
			instanceId: process.id,
			turnId: "create_external_item",
			turnType: "llm",
			status: "running",
			pathType: "primary",
		});
		const input = {
			instanceId: process.id,
			payload: {
				instanceId: process.id,
				turnRecordId: "trn_receipt",
				turnId: "create_external_item",
				turnType: "llm" as const,
				outcome: "created",
				params: {},
				pathType: "primary" as const,
				resultPiEntryId: "entry_result",
				turnResultMarkdown: "Created the external item",
			},
		};

		const missingReceipt = await TurnOutcome.decide(ctx(receiptDeps, process.id), input);
		expect(missingReceipt).toMatchObject({ ok: false, code: "ticket_receipt_missing" });

		receiptDeps.processes.update(process.id, {
			externalId: "EXT-123",
			externalUrl: "https://tracker.test/EXT-123",
		});
		const withReceipt = await TurnOutcome.decide(ctx(receiptDeps, process.id), input);

		expect(withReceipt.ok).toBe(true);
		if (!withReceipt.ok) return;
		expect(withReceipt.writes.processPatch.lifecycleStatus).toBe("completed");
	});

	it("TurnOutcome rejects when the action registry is not available", async () => {
		const deps = createDeps();
		const process = deps.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "generate_plan",
			lifecycleStatus: "active",
		});
		deps.turnRecords.create({
			id: "trn_outcome",
			instanceId: process.id,
			turnId: "generate_plan",
			turnType: "llm",
			status: "running",
			pathType: "primary",
		});

		const decision = await TurnOutcome.decide(ctx(deps, process.id), {
			instanceId: process.id,
			payload: {
				instanceId: process.id,
				turnRecordId: "trn_outcome",
				turnId: "generate_plan",
				turnType: "llm",
				outcome: "plan_saved",
				params: {},
				pathType: "primary",
				resultPiEntryId: "entry_result",
				turnResultMarkdown: "Result",
			},
		});

		expect(decision).toMatchObject({ ok: false, code: "registry_not_ready" });
	});

	it("ExecuteAction rejects when the action registry is not available", async () => {
		const deps = createDeps();
		const process = deps.processes.create({ processId: "ticket_issue_process" });

		const decision = await ExecuteAction.decide(ctx(deps, process.id), {
			instanceId: process.id,
			actionId: "approve_plan",
			input: {},
		});

		expect(decision).toMatchObject({ ok: false, code: "registry_not_ready" });
	});
});
