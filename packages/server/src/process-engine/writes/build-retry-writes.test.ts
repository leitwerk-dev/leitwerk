import type { ProcessTurnRecord, TurnStartRecord } from "@leitwerk-dev/domain";
import { describe, expect, it } from "vitest";
import { createDefaultTestProcessGraphRegistry } from "../../test-helpers/process-fixtures.js";
import { createTestDeps } from "../../test-helpers/unit-deps.js";
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
			processId: "ticket_issue_process",
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

	it("clears stale retry metadata when there is no fork node to reuse", () => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "ticket_issue_process",
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
			processId: "ticket_issue_process",
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
