import { ADMIN_ACTOR } from "@leitwerk-dev/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProcessOperationCoordinator } from "../process-operation-coordinator.js";
import { createFakeWorkerSupervisor } from "../test-helpers/fake-worker-supervisor.js";
import { createOwnedTestDeps as createTestDeps } from "../test-helpers/owned-test-deps.js";
import {
	createFixtureAutomaticTurn,
	createFixtureProcess,
	createProcessGraphRegistry,
} from "../test-helpers/process-fixtures.js";
import { createSelectedTurnStart } from "../test-helpers/unit-deps.js";
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
	const engineDeps = {
		...deps,
		processGraphs,
		processOperations,
		getSupervisor: () => supervisor,
	};
	const engine = createProcessEngine(engineDeps);
	const process = deps.processes.create({
		processId: "retry_fixture",
		selectedTurnId: "assess",
		lifecycleStatus: "error",
	});
	const start = createSelectedTurnStart(deps, {
		id: "tsr_failed",
		instanceId: process.id,
		turnId: "assess",
		turnType: "automatic",
		proposedTurnRecordId: "trn_unaccepted",
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
	const currentStart = () => {
		const execution = deps.processes.getById(process.id)?.currentExecution;
		const start = execution?.kind === "worker_start" ? deps.turnStarts.getById(execution.id) : null;
		if (!start) throw new Error("Expected a current startup record");
		return start;
	};
	return { deps, process, start, engine, engineDeps, supervisor, processOperations, currentStart };
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

afterEach(() => vi.useRealTimers());

describe("automatic startup recovery", () => {
	it("persists deadlines and the three-start budget across engine recreation", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-14T12:00:00Z"));
		const s = setup();
		const recover = () => s.engine.retryStartupAutomatically(s.process.id, s.currentStart().id);
		expect(await recover()).toMatchObject({
			ok: true,
			data: { status: "waiting", starts: 1, nextRetryAt: "2026-10-14T12:00:30.000Z" },
		});
		vi.setSystemTime(new Date("2026-10-14T12:00:20Z"));
		s.engine = createProcessEngine(s.engineDeps);
		expect(await recover()).toMatchObject({
			data: { status: "waiting", nextRetryAt: "2026-10-14T12:00:30.000Z" },
		});
		expect(s.currentStart().updatedAt).toBe(s.start.updatedAt);
		vi.setSystemTime(new Date("2026-10-14T12:00:30Z"));
		expect(await recover()).toMatchObject({ data: { status: "retried", starts: 2 } });
		await s.engine.recordWorkerFailure(s.process.id, {
			errorCode: "startup_timeout",
			message: "Timed out",
		});
		expect(await recover()).toMatchObject({
			data: { status: "waiting", starts: 2, nextRetryAt: "2026-10-14T12:01:30.000Z" },
		});
		vi.setSystemTime(new Date("2026-10-14T12:01:30Z"));
		s.engine = createProcessEngine(s.engineDeps);
		expect(await recover()).toMatchObject({ data: { status: "retried", starts: 3 } });
		await s.engine.recordWorkerFailure(s.process.id, {
			errorCode: "startup_timeout",
			message: "Timed out",
		});
		vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
		expect(await recover()).toMatchObject({ data: { status: "exhausted", starts: 3 } });
		expect(s.deps.turnStarts.listByInstance(s.process.id)).toHaveLength(3);
		expect(s.deps.turnRecords.listByInstance(s.process.id)).toEqual([]);
		expect(await s.engine.retryProcess(s.process.id, { actor: ADMIN_ACTOR })).toMatchObject({
			ok: true,
		});
		expect(s.currentStart()?.state.automaticRetry).toMatchObject({
			starts: 1,
			episodeStartRecordId: s.currentStart()?.id,
		});
	});

	it("blocks permanent and unknown failures without creating replacement starts", async () => {
		const s = setup("preparation_failed");
		const failed = s.currentStart();
		if (failed.state.kind !== "preparation_failed")
			throw new Error("Expected fixture preparation failure");
		s.deps.turnStarts.compareAndSetState({
			id: failed.id,
			expectedKind: "preparation_failed",
			state: { ...failed.state, code: "invalid_model_configuration" },
		});
		expect(await s.engine.retryStartupAutomatically(s.process.id, failed.id)).toMatchObject({
			ok: true,
			data: { status: "blocked" },
		});
		expect(s.deps.turnStarts.listByInstance(s.process.id)).toHaveLength(1);
		expect(s.supervisor.spawnCalls).toEqual([]);
	});

	it("fences duplicate triggers and a queued Stop", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-14T12:00:00Z"));
		const s = setup();
		vi.setSystemTime(new Date("2026-10-14T12:00:30Z"));
		const results = await Promise.all([
			s.engine.retryStartupAutomatically(s.process.id, s.start.id),
			s.engine.retryStartupAutomatically(s.process.id, s.start.id),
		]);
		expect(results.filter((r) => r.ok)).toHaveLength(1);
		expect(results).toContainEqual(
			expect.objectContaining({ ok: false, code: "stale_turn_start" }),
		);
		expect(s.supervisor.spawnCalls).toHaveLength(1);
		await s.engine.recordWorkerFailure(s.process.id, {
			errorCode: "startup_timeout",
			message: "Timed out",
		});
		const current = s.currentStart();
		const gate = Promise.withResolvers<void>();
		const locked = s.processOperations.runExclusive(s.process.id, () => gate.promise);
		const stopped = s.engine.abortProcess(s.process.id);
		const retry = s.engine.retryStartupAutomatically(s.process.id, current.id);
		gate.resolve();
		await locked;
		expect(await stopped).toMatchObject({ ok: true });
		expect(await retry).toMatchObject({ ok: false, code: "stale_turn_start" });
	});
});
