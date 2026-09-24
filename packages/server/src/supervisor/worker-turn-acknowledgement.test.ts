import { createIpcMessage } from "@leitwerk-dev/worker-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProcessEngine } from "../process-engine/engine.js";
import type { ProcessEngineDeps } from "../process-engine/types.js";
import { createProcessOperationCoordinator } from "../process-operation-coordinator.js";
import { createFakeWorkerSupervisor } from "../test-helpers/fake-worker-supervisor.js";
import {
	createFixtureAutomaticTurn,
	createFixtureProcess,
	createProcessGraphRegistry,
} from "../test-helpers/process-fixtures.js";
import { createTestDeps } from "../test-helpers/unit-deps.js";
import { createIpcHandler, type IpcHandlerDeps } from "./ipc-handler.js";

const databases: Array<ReturnType<typeof createTestDeps>["db"]> = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.$client.close();
});

function setup(
	options: {
		afterRecord?: ProcessEngineDeps["afterRecord"];
		getLaunchCoordinator?: IpcHandlerDeps["getLaunchCoordinator"];
	} = {},
) {
	const deps = createTestDeps();
	databases.push(deps.db);
	const definition = createFixtureProcess({
		id: "acknowledgement_fixture",
		entry: "work",
		turns: { work: createFixtureAutomaticTurn() },
	});
	const processOperations = createProcessOperationCoordinator();
	const supervisor = createFakeWorkerSupervisor();
	const engineDeps: ProcessEngineDeps = {
		...deps,
		processOperations,
		processGraphs: createProcessGraphRegistry([definition]),
		getSupervisor: () => supervisor,
		afterRecord: options.afterRecord,
	};
	const commands = createProcessEngine(engineDeps);
	const process = deps.processes.create({
		processId: definition.id,
		selectedTurnId: "work",
		lifecycleStatus: "active",
	});
	const start = deps.turnStarts.create({
		id: "start",
		instanceId: process.id,
		turnId: "work",
		turnType: "automatic",
		proposedTurnRecordId: "turn",
		startKind: "selected_turn",
		recoveryTurnRecordId: null,
		continuation: null,
		state: { kind: "starting", start: { kind: "automatic" } },
	});
	deps.processes.update(process.id, { currentExecution: { kind: "worker_start", id: start.id } });
	const lease = deps.leases.create({
		instanceId: process.id,
		workerId: "worker",
		state: "idle",
		turnStartRecordId: start.id,
	});
	deps.leases.compareAndSetBootstrapReceipt(lease.id, {
		kind: "automatic",
		startRecordId: start.id,
		workerLeaseId: lease.id,
		receiptEpoch: "epoch",
		readyAt: new Date().toISOString(),
	});
	const callbacks = {
		onWorkerTurnStartAccepted: vi.fn(() => ({
			startState: deps.turnStarts.getById(start.id)?.state.kind,
			turnStatus: deps.turnRecords.getById("turn")?.status,
		})),
		onTurnTerminalRecorded: vi.fn(),
		onTurnTerminalRecordingFailed: vi.fn(),
		onWorkerFailed: vi.fn(),
	};
	const handler = createIpcHandler(
		{ ...deps, commands, getLaunchCoordinator: options.getLaunchCoordinator },
		callbacks,
	);
	const sendStart = (startRecordId = start.id) =>
		handler.handleMessage(
			createIpcMessage({
				type: "worker.turn_started",
				instanceId: process.id,
				workerId: lease.workerId,
				messageId: crypto.randomUUID(),
				payload: { startRecordId, proposedTurnRecordId: "turn" },
			}),
		);
	const sendTerminal = (kind: "outcome" | "failure") => {
		const correlation = {
			turnRecordId: "turn",
			turnId: "work",
			turnType: "automatic" as const,
			pathType: "primary" as const,
		};
		handler.handleMessage(
			createIpcMessage({
				instanceId: process.id,
				workerId: lease.workerId,
				messageId: crypto.randomUUID(),
				...(kind === "outcome"
					? {
							type: "worker.turn_outcome" as const,
							payload: { ...correlation, outcome: "done", params: {} },
						}
					: {
							type: "worker.turn_failed" as const,
							payload: { ...correlation, errorSummary: "Worker failed" },
						}),
			}),
		);
	};
	return {
		deps,
		process,
		start,
		lease,
		commands,
		engineDeps,
		processOperations,
		callbacks,
		sendStart,
		sendTerminal,
	};
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("worker turn acknowledgements through durable recording", () => {
	it("acknowledges acceptance after unlocking and before post-commit work finishes", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const s = setup({
			afterRecord: async () => {
				entered.resolve();
				await release.promise;
			},
		});
		s.sendStart();
		await entered.promise;
		try {
			expect(s.callbacks.onWorkerTurnStartAccepted).toHaveBeenCalledWith(
				s.process.id,
				s.lease.workerId,
				{ startRecordId: s.start.id, turnRecordId: "turn" },
			);
			expect(s.callbacks.onWorkerTurnStartAccepted.mock.results[0]?.value).toEqual({
				startState: "accepted",
				turnStatus: "running",
			});
			await s.processOperations.runExclusive(s.process.id, () => {
				expect(s.deps.turnRecords.getById("turn")?.attemptNumber).toBe(1);
			});
		} finally {
			release.resolve();
			await flush();
		}
	});

	it.each([
		"post_commit",
		"projection",
	] as const)("acknowledges durable acceptance and replay despite %s failure", async (failure) => {
		const fail = () => {
			throw new Error("Injected failure after acceptance");
		};
		const s = setup(
			failure === "post_commit"
				? { afterRecord: fail }
				: { getLaunchCoordinator: () => ({ refresh: fail }) as never },
		);
		s.sendStart();
		await flush();
		s.sendStart();
		await flush();
		expect(s.callbacks.onWorkerTurnStartAccepted).toHaveBeenCalledTimes(2);
		expect(
			s.callbacks.onWorkerTurnStartAccepted.mock.results.map((result) => result.value),
		).toEqual([
			{ startState: "accepted", turnStatus: "running" },
			{ startState: "accepted", turnStatus: "running" },
		]);
		expect(s.callbacks.onWorkerFailed).not.toHaveBeenCalled();
		expect(s.deps.turnRecords.listByInstance(s.process.id)).toHaveLength(1);
		expect(s.deps.turnRecords.getById("turn")?.attemptNumber).toBe(1);
	});

	it("does not acknowledge rejected or uncommitted starts", async () => {
		const s = setup();
		s.sendStart("stale");
		await flush();
		s.engineDeps.transaction = () => {
			throw new Error("Injected storage failure");
		};
		s.sendStart();
		await flush();
		expect(s.callbacks.onWorkerTurnStartAccepted).not.toHaveBeenCalled();
		expect(s.callbacks.onWorkerFailed).toHaveBeenCalledTimes(2);
		expect(s.deps.turnRecords.listByInstance(s.process.id)).toEqual([]);
		expect(s.deps.turnStarts.getById(s.start.id)?.state.kind).toBe("starting");
	});

	it("keeps a retry authoritative over an old worker outcome queued behind it", async () => {
		const s = setup();
		s.sendStart();
		await flush();
		expect(
			await s.commands.recordTurnFailed(s.process.id, {
				instanceId: s.process.id,
				turnRecordId: "turn",
				turnId: "work",
				turnType: "automatic",
				pathType: "primary",
				errorSummary: "Original failure",
			}),
		).toMatchObject({ ok: true });
		s.deps.leases.update(s.lease.id, { state: "draining" });
		const gate = Promise.withResolvers<void>();
		const locked = s.processOperations.runExclusive(s.process.id, () => gate.promise);
		const retried = s.commands.retryProcess(s.process.id);
		s.sendTerminal("outcome");
		gate.resolve();
		await locked;
		expect(await retried).toMatchObject({ ok: true });
		await flush();
		const current = s.deps.processes.getById(s.process.id);
		expect(current?.lifecycleStatus).toBe("active");
		if (current?.currentExecution?.kind !== "worker_start") throw new Error("Missing retry start");
		expect(current.currentExecution.id).not.toBe(s.start.id);
		expect(s.deps.turnStarts.getById(current.currentExecution.id)?.state.kind).toBe("starting");
		expect(s.callbacks.onTurnTerminalRecordingFailed).toHaveBeenCalledWith(
			expect.objectContaining({ code: "stale_turn_record" }),
		);
	});

	it.each([
		"outcome",
		"failure",
	] as const)("does not acknowledge %s when neither terminal recording nor fallback commits", async (kind) => {
		const s = setup();
		s.sendStart();
		await flush();
		s.engineDeps.transaction = () => {
			throw new Error("Injected storage failure");
		};
		s.sendTerminal(kind);
		await flush();
		expect(s.callbacks.onTurnTerminalRecorded).not.toHaveBeenCalled();
		expect(s.deps.turnRecords.getById("turn")?.status).toBe("running");
		expect(s.callbacks.onTurnTerminalRecordingFailed).toHaveBeenCalled();
	});
});
