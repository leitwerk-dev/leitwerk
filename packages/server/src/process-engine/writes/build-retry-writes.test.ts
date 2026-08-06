import type { ProcessTurnRecord, TurnStartRecord } from "@leitwerk-dev/domain";
import { serverAutomaticTurn } from "@leitwerk-dev/process-sdk";
import { describe, expect, it } from "vitest";
import { createProcessOperationCoordinator } from "../../process-operation-coordinator.js";
import {
	createDefaultTestProcessGraphRegistry,
	createFixtureProcess,
	createProcessGraphRegistry,
} from "../../test-helpers/process-fixtures.js";
import { createTestDeps } from "../../test-helpers/unit-deps.js";
import { RetryFailedTurn } from "../ops/retry-failed-turn.js";
import type { DecideContext, ProcessEngineDeps } from "../types.js";
import { buildRetryWrites } from "./build-retry-writes.js";

const processGraphs = createDefaultTestProcessGraphRegistry();

function requireAcceptedStart(
	deps: ReturnType<typeof createTestDeps>,
	turnRecord: ProcessTurnRecord,
): TurnStartRecord {
	if (!turnRecord.turnStartRecordId) throw new Error("Fixture turn is missing its accepted start");
	const start = deps.turnStarts.getById(turnRecord.turnStartRecordId);
	if (!start) throw new Error("Fixture accepted start was not persisted");
	return start;
}

describe("buildRetryWrites", () => {
	it("reactivates the failed turn and preserves retry lineage metadata", () => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "jira_issue_process",
			selectedTurnId: "plan_review",
			lifecycleStatus: "error",
			metadata: { externalRef: "JRA-123" },
		});
		const failedRun = deps.turnRecords.create({
			id: "trn_impl_2",
			instanceId: process.id,
			turnId: "implement",
			status: "failed",
			attemptNumber: 2,
			pathType: "primary",
			forkPiEntryId: "pi_pre_impl",
		});

		const planned = buildRetryWrites({
			processGraphs,
			process,
			failedRun,
			acceptedStart: requireAcceptedStart(deps, failedRun),
		});

		expect(planned.processPatch).toMatchObject({
			selectedTurnId: "implement",
			lifecycleStatus: "active",
			metadata: {
				externalRef: "JRA-123",
				retryForkPiEntryId: "pi_pre_impl",
				retryFromTurnRecordId: "trn_impl_2",
			},
		});
		expect(planned.changedFields).toEqual(
			expect.arrayContaining(["selectedTurnId", "lifecycleStatus", "metadata"]),
		);
		expect(planned.workerIntent).toEqual({ kind: "restart_worker" });
		expect(planned.events).toEqual([
			{
				instanceId: process.id,
				eventType: "retry_scheduled",
				data: {
					fromTurnId: "plan_review",
					toTurnId: "implement",
					selectedTurnId: "implement",
					failedTurnRecord: "trn_impl_2",
					retryForkPiEntryId: "pi_pre_impl",
					attemptNumber: 2,
				},
			},
		]);
		expect(planned.broadcasts).toEqual([
			{
				type: "process.event",
				payload: {
					eventType: "retry_scheduled",
					level: "info",
					message: "Retry scheduled for turn implement",
				},
				instanceId: process.id,
			},
		]);
	});

	it("retries server-automatic failures directly without an accepted worker start", () => {
		const serverAutomaticProcess = createFixtureProcess({
			id: "server_automatic_retry_process",
			entry: "server_cleanup",
			turns: {
				server_cleanup: serverAutomaticTurn({
					description: "Server cleanup",
					run: async () => ({ outcome: "done", params: {} }),
					turnEnd: { outcome: "done", params: {}, complete: true },
				}),
			},
		});
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: serverAutomaticProcess.id,
			selectedTurnId: "server_cleanup",
			lifecycleStatus: "error",
		});
		const failedRun = deps.turnRecords.create({
			id: "trn_cleanup_1",
			instanceId: process.id,
			turnId: "server_cleanup",
			turnType: "server_automatic",
			status: "failed",
			attemptNumber: 1,
			pathType: "primary",
		});
		deps.processes.update(process.id, {
			currentExecution: { kind: "server_turn", id: failedRun.id },
		});
		const engineDeps: ProcessEngineDeps = {
			...deps,
			processOperations: createProcessOperationCoordinator(),
			getSupervisor: () => undefined,
			processGraphs: createProcessGraphRegistry([serverAutomaticProcess]),
		};
		const currentProcess = deps.processes.getById(process.id);
		if (!currentProcess) throw new Error("Fixture process was not persisted");
		const context: DecideContext = {
			deps: engineDeps,
			instanceId: process.id,
			process: currentProcess,
		};

		const decision = RetryFailedTurn.decide(context, {
			instanceId: process.id,
		});

		expect(decision).toMatchObject({ ok: true });
		if (!decision.ok) return;
		expect(decision.writes.processPatch).toMatchObject({
			lifecycleStatus: "active",
			currentExecution: { kind: "server_turn" },
		});
		expect(decision.writes.turnStartWrites).toEqual([]);
		expect(decision.writes.turnRecordWrites).toEqual([
			expect.objectContaining({
				kind: "create",
				input: expect.objectContaining({
					turnType: "server_automatic",
					parentTurnRecordId: failedRun.id,
					attemptNumber: 2,
				}),
			}),
		]);
	});

	it("clears stale retry metadata when there is no fork node to reuse", () => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "jira_issue_process",
			selectedTurnId: "implement",
			lifecycleStatus: "error",
			metadata: {
				externalRef: "JRA-456",
				retryForkPiEntryId: "stale_node",
				retryFromTurnRecordId: "trn_old",
			},
		});
		const failedRun = deps.turnRecords.create({
			id: "trn_impl_3",
			instanceId: process.id,
			turnId: "implement",
			status: "failed",
			attemptNumber: 3,
			pathType: "primary",
		});

		const planned = buildRetryWrites({
			processGraphs,
			process,
			failedRun,
			acceptedStart: requireAcceptedStart(deps, failedRun),
		});

		expect(planned.processPatch.metadata).toEqual({ externalRef: "JRA-456" });
	});

	it("clears stale continuation metadata before scheduling retry", () => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "jira_issue_process",
			selectedTurnId: "implement",
			lifecycleStatus: "error",
			metadata: {
				externalRef: "JRA-789",
				continueFromPiEntryId: "assistant-timeout-2",
				continueFromTurnRecordId: "trn_impl_timeout_2",
				continueSavedPrimaryLeafEntryId: "primary-leaf-7",
				continuePrompt: "Please finish the summary.",
				failedTurnRecovery: {
					turnRecordId: "trn_impl_timeout_2",
					strategy: "continue",
					suggestedContinuePrompt: "Please finish the summary.",
					failureCode: "missing_markdown_result",
					missingToolNames: ["markdown_result"],
				},
			},
		});
		const failedRun = deps.turnRecords.create({
			id: "trn_impl_4",
			instanceId: process.id,
			turnId: "implement",
			status: "failed",
			attemptNumber: 4,
			pathType: "primary",
			forkPiEntryId: "pi_pre_impl",
		});

		const planned = buildRetryWrites({
			processGraphs,
			process,
			failedRun,
			acceptedStart: requireAcceptedStart(deps, failedRun),
		});

		expect(planned.processPatch.metadata).toEqual({
			externalRef: "JRA-789",
			retryForkPiEntryId: "pi_pre_impl",
			retryFromTurnRecordId: "trn_impl_4",
		});
	});
});
