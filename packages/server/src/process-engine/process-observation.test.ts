import { expect, it } from "vitest";
import { createProcessOperationCoordinator } from "../process-operation-coordinator.js";
import { createOwnedTestDeps } from "../test-helpers/owned-test-deps.js";
import {
	createFixtureAutomaticTurn,
	createFixtureProcess,
	createProcessGraphRegistry,
} from "../test-helpers/process-fixtures.js";
import { createProcessEngine } from "./engine.js";
import { pendingTurnWait } from "./turn-wait-state.js";

function fixture(accepted = true) {
	const deps = createOwnedTestDeps();
	const definition = createFixtureProcess({
		id: "maintained",
		entry: "repair",
		turns: {
			repair: createFixtureAutomaticTurn(),
			deliver: { ...createFixtureAutomaticTurn(), waitFor: () => false },
		},
	});
	const engine = createProcessEngine({
		...deps,
		processGraphs: createProcessGraphRegistry([definition]),
		processOperations: createProcessOperationCoordinator(),
		getSupervisor: () => undefined,
	});
	const process = deps.processes.create({
		processId: definition.id,
		paramsJson: "{}",
		stateJson: "{}",
		selectedTurnId: "repair",
		lifecycleStatus: "active",
	});
	const lease = deps.leases.create({ instanceId: process.id, workerId: "worker", state: "busy" });
	const start = deps.turnStarts.create({
		id: "start",
		instanceId: process.id,
		turnId: "repair",
		turnType: "automatic",
		proposedTurnRecordId: "record",
		startKind: "selected_turn",
		state: accepted
			? {
					kind: "accepted",
					start: { kind: "automatic" },
					turnRecordId: "record",
					acceptedWorkerLeaseId: lease.id,
				}
			: { kind: "starting", start: { kind: "automatic" } },
	});
	if (accepted)
		deps.turnRecords.create({
			id: "record",
			instanceId: process.id,
			turnId: "repair",
			turnType: "automatic",
			turnStartRecordId: start.id,
			acceptedWorkerLeaseId: lease.id,
			status: "running",
			pathType: "primary",
		});
	deps.processes.update(process.id, { currentExecution: { kind: "worker_start", id: start.id } });
	const read = () => {
		const value = deps.processes.getById(process.id);
		if (!value) throw new Error("Missing process");
		return value;
	};
	return { deps, engine, read, process };
}

it("records observations during work without creating an attempt or changing business position", async () => {
	const f = fixture();
	const before = f.read();
	expect(
		await f.engine.applyProcessObservation(before.id, {
			expected: before,
			metadata: { maintenance: { pipeline: "running" } },
			preserveUpdatedAt: true,
		}),
	).toMatchObject({ ok: true });
	expect(f.read()).toMatchObject({
		selectedTurnId: "repair",
		lifecycleStatus: "active",
		updatedAt: before.updatedAt,
	});
	expect(f.deps.turnRecords.listByInstance(before.id)).toHaveLength(1);
	expect(f.deps.turnStarts.listByInstance(before.id)).toHaveLength(1);
});

it.each([
	true,
	false,
])("supersedes accepted=%s work and fences late outcomes while recovering to a gated turn", async (accepted) => {
	const f = fixture(accepted);
	const before = f.read();
	expect(
		await f.engine.applyProcessObservation(before.id, {
			expected: before,
			metadata: { maintenance: { stopped: true } },
			interrupt: { turnId: "deliver", reason: "Active label removed" },
		}),
	).toMatchObject({ ok: true });
	expect(f.read()).toMatchObject({
		selectedTurnId: "deliver",
		lifecycleStatus: "waiting",
		currentExecution: null,
	});
	expect(pendingTurnWait(f.read())?.turnId).toBe("deliver");
	if (accepted) expect(f.deps.turnRecords.getById("record")?.status).toBe("superseded");
	else expect(f.deps.turnStarts.getById("start")?.state.kind).toBe("superseded");
	expect(
		await f.engine.recordTurnOutcome(before.id, {
			turnId: "repair",
			turnRecordId: "record",
			outcome: "done",
			params: {},
		}),
	).toMatchObject({ ok: false });
	expect(f.read().metadata?.maintenance).toEqual({ stopped: true });
	expect(f.deps.turnRecords.listByInstance(before.id)).toHaveLength(accepted ? 1 : 0);
});

it("rejects reads superseded by state, projects or maintenance ownership", async () => {
	const f = fixture();
	const before = f.read();
	await f.engine.applyProcessObservation(before.id, {
		expected: before,
		metadata: { maintenance: { stopped: true } },
	});
	expect(
		await f.engine.applyProcessObservation(before.id, {
			expected: before,
			metadata: { maintenance: { stopped: false } },
		}),
	).toMatchObject({ ok: false, code: "observation_superseded" });
	const current = f.read();
	f.deps.projects.create({
		instanceId: before.id,
		key: "repo",
		repoLocator: "/tmp/repo",
		baseBranch: "main",
	});
	expect(
		await f.engine.applyProcessObservation(before.id, {
			expected: current,
			projectsJson: "[]",
			state: {},
		}),
	).toMatchObject({ ok: false, code: "observation_superseded" });
});

it("ends maintenance and cancels scheduled actions without a terminal Deliver attempt", async () => {
	const f = fixture();
	const before = f.read();
	f.deps.futureExecutions.create({
		id: "scheduled",
		kind: "action",
		scheduleKind: "once",
		processId: before.processId,
		instanceId: before.id,
		actionId: "retry",
		payloadJson: "{}",
		nextRunAt: "2099-01-01T00:00:00.000Z",
	});
	expect(
		await f.engine.applyProcessObservation(before.id, {
			expected: before,
			lifecycleStatus: "aborted",
		}),
	).toMatchObject({ ok: true });
	expect(f.read()).toMatchObject({
		selectedTurnId: null,
		lifecycleStatus: "aborted",
		currentExecution: null,
	});
	expect(f.deps.turnRecords.getById("record")?.status).toBe("superseded");
	expect(f.deps.futureExecutions.getById("scheduled")).toBeNull();
});
