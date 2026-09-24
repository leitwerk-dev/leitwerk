import { ADMIN_ACTOR } from "@leitwerk-dev/domain";
import { describe, expect, it } from "vitest";
import { createProcessOperationCoordinator } from "../process-operation-coordinator.js";
import { createFakeWorkerSupervisor } from "../test-helpers/fake-worker-supervisor.js";
import { createOwnedTestDeps as createTestDeps } from "../test-helpers/owned-test-deps.js";
import {
	createFixtureAutomaticTurn,
	createFixtureProcess,
	createProcessGraphRegistry,
} from "../test-helpers/process-fixtures.js";
import { createProcessEngine } from "./engine.js";

function setup(kind: "bootstrap_failed" | "preparation_failed" = "bootstrap_failed") {
	const deps = createTestDeps();
	const processGraphs = createProcessGraphRegistry([
		createFixtureProcess({
			id: "retry_fixture",
			entry: "assess",
			turns: { assess: createFixtureAutomaticTurn() },
		}),
	]);
	const supervisor = createFakeWorkerSupervisor();
	const processOperations = createProcessOperationCoordinator();
	const engine = createProcessEngine({
		...deps,
		processGraphs,
		processOperations,
		getSupervisor: () => supervisor,
	});
	const process = deps.processes.create({
		processId: "retry_fixture",
		selectedTurnId: "assess",
		lifecycleStatus: "error",
	});
	const start = deps.turnStarts.create({
		id: "tsr_failed",
		instanceId: process.id,
		turnId: "assess",
		turnType: "automatic",
		proposedTurnRecordId: "trn_unaccepted",
		startKind: "selected_turn",
		recoveryTurnRecordId: null,
		continuation: null,
		state:
			kind === "bootstrap_failed"
				? {
						kind,
						start: { kind: "automatic" },
						failedWorkerLeaseId: null,
						code: "startup_timeout",
						safeSummary: "Worker startup timed out",
					}
				: {
						kind,
						requestedModelProfileId: null,
						providerOptions: {},
						code: "model_unavailable",
						safeSummary: "Start preparation unavailable",
					},
	});
	deps.processes.update(process.id, { currentExecution: { kind: "worker_start", id: start.id } });
	const currentStart = () => {
		const execution = deps.processes.getById(process.id)?.currentExecution;
		return execution?.kind === "worker_start" ? deps.turnStarts.getById(execution.id) : null;
	};
	return { deps, process, start, engine, supervisor, processOperations, currentStart };
}

describe("generic process retry", () => {
	it("restarts an unaccepted automatic turn without consuming an attempt", async () => {
		const s = setup();
		expect(await s.engine.retryProcess(s.process.id, { actor: ADMIN_ACTOR })).toMatchObject({
			ok: true,
			process: { lifecycleStatus: "active", selectedTurnId: "assess" },
		});
		expect(s.currentStart()).toMatchObject({
			startKind: "startup_retry",
			state: { kind: "starting", start: { kind: "automatic" } },
		});
		expect(s.currentStart()?.id).not.toBe(s.start.id);
		expect(s.deps.turnRecords.listByInstance(s.process.id)).toEqual([]);
		expect(s.supervisor.spawnCalls).toEqual([s.process.id]);
		expect(s.deps.events.listByInstance(s.process.id)).toContainEqual(
			expect.objectContaining({
				eventType: "startup_retry_scheduled",
				data: expect.objectContaining({ actor: ADMIN_ACTOR }),
			}),
		);
	});

	it("routes preparation failures through startup recovery", async () => {
		const s = setup("preparation_failed");
		expect(await s.engine.retryProcess(s.process.id)).toMatchObject({ ok: true });
		expect(s.currentStart()).toMatchObject({ startKind: "startup_retry" });
		expect(s.currentStart()?.id).not.toBe(s.start.id);
		expect(s.deps.turnRecords.listByInstance(s.process.id)).toEqual([]);
	});

	it("keeps a queued operator Stop authoritative over a stale startup retry", async () => {
		const s = setup();
		const gate = Promise.withResolvers<void>();
		const locked = s.processOperations.runExclusive(s.process.id, () => gate.promise);
		const stopped = s.engine.abortProcess(s.process.id);
		const retried = s.engine.retryProcess(s.process.id);
		gate.resolve();
		await locked;
		expect(await stopped).toMatchObject({ ok: true });
		expect(await retried).toMatchObject({ ok: false, code: "stale_turn_start" });
		expect(s.deps.processes.getById(s.process.id)?.lifecycleStatus).toBe("aborted");
		expect(s.deps.turnRecords.listByInstance(s.process.id)).toEqual([]);
		expect(s.supervisor.spawnCalls).toEqual([]);
	});

	it("retains accepted failed-turn retry lineage", async () => {
		const s = setup();
		const failed = s.deps.turnRecords.create({
			instanceId: s.process.id,
			turnId: "assess",
			turnType: "automatic",
			status: "failed",
		});
		expect(await s.engine.retryProcess(s.process.id)).toMatchObject({ ok: true });
		expect(s.currentStart()).toMatchObject({
			startKind: "retry",
			recoveryTurnRecordId: failed.id,
			state: { kind: "starting" },
		});
		expect(s.deps.turnRecords.listByInstance(s.process.id)).toHaveLength(1);
		expect(s.supervisor.spawnCalls).toEqual([s.process.id]);
	});
});
