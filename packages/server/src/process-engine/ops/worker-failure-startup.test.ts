import { describe, expect, it } from "vitest";
import { createProcessOperationCoordinator } from "../../process-operation-coordinator.js";
import { createDefaultTestProcessGraphRegistry } from "../../test-helpers/process-fixtures.js";
import { createTestDeps } from "../../test-helpers/unit-deps.js";
import type { DecideContext, ProcessEngineDeps } from "../types.js";
import { WorkerFailure } from "./worker-failure.js";

function setup() {
	const base = createTestDeps();
	const deps: ProcessEngineDeps = {
		...base,
		processOperations: createProcessOperationCoordinator(),
		getSupervisor: () => undefined,
		processGraphs: createDefaultTestProcessGraphRegistry(),
	};
	const process = deps.processes.create({
		processId: "ticket_issue_process",
		selectedTurnId: "generate_plan",
		lifecycleStatus: "active",
	});
	const start = deps.turnStarts.create({
		id: "tsr_starting",
		instanceId: process.id,
		turnId: "generate_plan",
		turnType: "llm",
		proposedTurnRecordId: "trn_reserved",
		startKind: "selected_turn",
		recoveryTurnRecordId: null,
		continuation: null,
		state: {
			kind: "starting",
			start: {
				kind: "llm",
				model: {
					profileId: "profile",
					providerId: "provider",
					modelId: "model",
					thinkingLevel: "off",
				},
				providerOptions: {},
				providerWorkerConfig: null,
				piResourceSnapshotDigest: "digest",
				workerRuntimeProfileId: "local",
				piSettings: {},
			},
		},
	});
	deps.processes.update(process.id, {
		currentExecution: { kind: "worker_start", id: start.id },
	});
	const lease = deps.leases.create({
		instanceId: process.id,
		workerId: "worker-current",
		state: "bootstrapping",
	});
	const context = (): DecideContext => {
		const current = deps.processes.getById(process.id);
		if (!current) throw new Error("Fixture process was not persisted");
		return { deps, instanceId: process.id, process: current };
	};
	return { deps, process, start, lease, context };
}

describe("WorkerFailure startup correlation", () => {
	it("ignores a late failure from a lease that no longer owns the current start", () => {
		const s = setup();
		const decision = WorkerFailure.decide(s.context(), {
			instanceId: s.process.id,
			payload: {
				errorCode: "process_exited",
				message: "late old-worker exit",
				workerLeaseId: "lease-old",
			},
		});
		expect(decision).toMatchObject({ ok: true });
		if (decision.ok) {
			expect(decision.writes.turnStartWrites).toEqual([]);
			expect(decision.writes.changedFields).toEqual([]);
		}
	});

	it("parks a starting record for the current physical lease without creating an attempt", () => {
		const s = setup();
		const decision = WorkerFailure.decide(s.context(), {
			instanceId: s.process.id,
			payload: {
				errorCode: "process_exited",
				message: "worker exited during bootstrap",
				workerLeaseId: s.lease.id,
			},
		});
		expect(decision).toMatchObject({ ok: true });
		if (!decision.ok) return;
		expect(decision.writes.turnRecordWrites).toEqual([]);
		expect(decision.writes.processPatch.lifecycleStatus).toBe("error");
		expect(decision.writes.turnStartWrites).toEqual([
			expect.objectContaining({
				kind: "cas_state",
				id: s.start.id,
				state: expect.objectContaining({
					kind: "bootstrap_failed",
					failedWorkerLeaseId: s.lease.id,
				}),
			}),
		]);
	});
});
