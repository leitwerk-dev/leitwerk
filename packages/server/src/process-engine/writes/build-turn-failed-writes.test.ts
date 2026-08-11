import { createGenericFailedTurnRecoveryContext } from "@leitwerk-dev/domain";
import { describe, expect, it } from "vitest";
import { createTestDeps } from "../../test-helpers/unit-deps.js";
import { buildTurnFailedWrites } from "./build-turn-failed-writes.js";

const genericRecoveryContext = createGenericFailedTurnRecoveryContext();
const promptBranchDriftDetails = {
	operation: "prompt",
	anchorEntryId: "user-plan",
	rejectedResultEntryId: "turn-stale",
} as const;

describe("buildTurnFailedWrites", () => {
	it("updates an existing turn record and parks the process in lifecycle error", () => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "implement",
			lifecycleStatus: "active",
		});
		const existingTurnRecord = deps.turnRecords.create({
			id: "trn_impl_1",
			instanceId: process.id,
			turnId: "implement",
			status: "running",
			pathType: "primary",
		});
		const currentProcess = deps.processes.getById(process.id);
		if (!currentProcess) throw new Error("Fixture process was not persisted");

		const planned = buildTurnFailedWrites({
			process: currentProcess,
			payload: {
				instanceId: process.id,
				turnRecordId: "trn_impl_1",
				turnId: "implement",
				turnType: "llm",
				pathType: "primary",
				resultPiEntryId: "pi_result_impl",
				errorSummary: "LLM timeout",
				errorClass: "llm_error",
				recoveryContext: genericRecoveryContext,
			},
			existingTurnRecord,
			endedAt: "2026-04-09T00:00:00.000Z",
		});

		expect(planned.turnRecordWrites).toEqual([
			{
				kind: "update",
				id: "trn_impl_1",
				input: {
					status: "failed",
					resultPiEntryId: "pi_result_impl",
					errorSummary: "LLM timeout",
					errorClass: "llm_error",
					turnType: "llm",
					endedAt: "2026-04-09T00:00:00.000Z",
				},
			},
		]);
		expect(planned.processPatch).toMatchObject({
			lifecycleStatus: "error",
			metadata: {
				failedTurnRecovery: {
					turnRecordId: "trn_impl_1",
					strategy: "continue",
					suggestedContinuePrompt: "continue",
					failureCode: "generic_continue",
				},
			},
		});
		expect(planned.processPatch.currentExecution).toBeUndefined();
		expect(planned.events).toEqual([
			{
				instanceId: process.id,
				eventType: "turn_failed",
				data: {
					turnRecordId: "trn_impl_1",
					turnId: "implement",
					turnType: "llm",
					errorSummary: "LLM timeout",
					errorClass: "llm_error",
				},
			},
		]);
	});

	it.each([
		["without recovery context", null],
		["with recovery context", genericRecoveryContext],
	] as const)("records branch drift as non-continuable %s", (_name, recoveryContext) => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "generate_plan",
			lifecycleStatus: "active",
		});
		const existingTurnRecord = deps.turnRecords.create({
			id: "trn_plan_drift",
			instanceId: process.id,
			turnId: "generate_plan",
			status: "running",
			pathType: "primary",
		});
		const currentProcess = deps.processes.getById(process.id);
		if (!currentProcess) throw new Error("Fixture process was not persisted");

		const planned = buildTurnFailedWrites({
			process: currentProcess,
			payload: {
				instanceId: process.id,
				turnRecordId: "trn_plan_drift",
				turnId: "generate_plan",
				turnType: "llm",
				pathType: "primary",
				resultPiEntryId: promptBranchDriftDetails.rejectedResultEntryId,
				errorSummary: "Result branch drifted",
				errorClass: "infrastructure",
				failureCode: "branch_drift",
				failureDetails: promptBranchDriftDetails,
				recoveryContext,
			},
			existingTurnRecord,
			endedAt: "2026-04-09T00:30:00.000Z",
		});

		expect(planned.turnRecordWrites[0]).toMatchObject({
			kind: "update",
			id: "trn_plan_drift",
			input: { resultPiEntryId: null },
		});
		expect(planned.processPatch.metadata).toBeUndefined();
		expect(planned.events[0]?.data).toMatchObject({
			turnRecordId: "trn_plan_drift",
			failureCode: "branch_drift",
			failureDetails: promptBranchDriftDetails,
		});
	});
});
