import { describe, expect, it } from "vitest";
import { createDefaultTestProcessGraphRegistry } from "../../test-helpers/process-fixtures.js";
import { createTestDeps } from "../../test-helpers/unit-deps.js";
import { buildWorkerFailureWrites } from "./build-worker-failure-writes.js";

const processGraphs = createDefaultTestProcessGraphRegistry();

describe("buildWorkerFailureWrites", () => {
	it("fails the active running turn, parks the process, and requests worker shutdown", () => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "jira_issue_process",
			selectedTurnId: "implement",
			lifecycleStatus: "active",
		});
		const activeTurnRecord = deps.turnRecords.create({
			id: "trn_impl_1",
			instanceId: process.id,
			turnId: "implement",
			turnType: "llm",
			status: "running",
			pathType: "primary",
			forkPiEntryId: "pi_pre_impl",
			resultPiEntryId: "pi_partial_impl",
		});
		const currentProcess = deps.processes.getById(process.id);
		if (!currentProcess) throw new Error("Fixture process was not persisted");

		const planned = buildWorkerFailureWrites({
			processGraphs,
			process: currentProcess,
			message: "Worker exited unexpectedly",
			errorCode: "process_exited",
			errorClass: "infrastructure",
			activeTurnRecord,
			endedAt: "2026-04-17T12:00:00.000Z",
		});

		expect(planned.workerIntent).toEqual({
			kind: "stop_with_reason",
			reason: "worker_failed:process_exited",
		});
		expect(planned.turnRecordWrites).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "update",
					id: "trn_impl_1",
					input: expect.objectContaining({
						status: "failed",
						errorSummary: "Worker exited unexpectedly",
						errorClass: "infrastructure",
					}),
				}),
			]),
		);
		expect(planned.processPatch).toMatchObject({
			lifecycleStatus: "error",
		});
		expect(planned.processPatch.currentExecution).toBeUndefined();
		expect(planned.events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					eventType: "turn_failed",
					data: expect.objectContaining({
						turnRecordId: "trn_impl_1",
						turnId: "implement",
						errorSummary: "Worker exited unexpectedly",
					}),
				}),
				expect.objectContaining({
					eventType: "lifecycle_parked",
					data: expect.objectContaining({
						selectedTurnId: "implement",
						reason: "Worker exited unexpectedly",
						errorCode: "process_exited",
					}),
				}),
			]),
		);
	});

	it("parks the process even when no running turn record exists", () => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "jira_issue_process",
			selectedTurnId: "generate_plan",
			lifecycleStatus: "active",
		});

		const planned = buildWorkerFailureWrites({
			processGraphs,
			process,
			message: "Worker startup timed out",
			errorCode: "startup_timeout",
			errorClass: "infrastructure",
			endedAt: "2026-04-17T12:05:00.000Z",
		});

		expect(planned.workerIntent).toEqual({
			kind: "stop_with_reason",
			reason: "worker_failed:startup_timeout",
		});
		expect(planned.turnRecordWrites).toEqual([]);
		expect(planned.processPatch).toMatchObject({
			lifecycleStatus: "error",
		});
		expect(planned.events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					eventType: "lifecycle_parked",
					data: expect.objectContaining({
						selectedTurnId: "generate_plan",
						reason: "Worker startup timed out",
						errorCode: "startup_timeout",
					}),
				}),
			]),
		);
	});
});
