import type { ProcessInput, ProcessInstance } from "@leitwerk-dev/domain";
import type { IpcEnvelope } from "@leitwerk-dev/worker-protocol";
import type { WorkerUnit, WorkerUnitDescriptor } from "@leitwerk-dev/worker-runners/types";
import { describe, expect, it, vi } from "vitest";
import type { RepositoryBundle } from "../../db/repositories.js";
import type { WorkerHandle } from "../worker-supervisor.js";
import { createWorkerUnitReclaimer } from "../worker-unit-reclaimer.js";
import type { WorkerWebSocketIpcManager } from "../worker-websocket-ipc.js";
import { createWorkerAdoptionCoordinator } from "./worker-adoption-coordinator.js";

function unit(descriptor: WorkerUnitDescriptor): WorkerUnit {
	return {
		...descriptor,
		onExit() {},
	};
}

function handle(workerUnit: WorkerUnit): WorkerHandle {
	return {
		instanceId: workerUnit.instanceId,
		workerId: workerUnit.workerId,
		unitId: workerUnit.unitId,
		namespace: workerUnit.namespace,
		send: vi.fn(),
		kill: vi.fn(),
		detach: vi.fn(),
		onceExit: vi.fn(),
	};
}

function input(id: string, sequence: number): ProcessInput {
	return {
		id,
		instanceId: "proc-1",
		sequence,
		source: "system",
		kind: "instruction",
		target: null,
		bodyMarkdown: id,
		actor: { id: "operator", kind: "user", provider: null },
		receivedAt: new Date(0).toISOString(),
		consumedAt: null,
	};
}

function heartbeat(sequence = 0): IpcEnvelope {
	return {
		protocol: "leitwerk/ipc/v1",
		type: "worker.heartbeat",
		instanceId: "proc-1",
		workerId: "wkr-1",
		messageId: "hb-1",
		sentAt: new Date(0).toISOString(),
		payload: { state: "busy", lastSequenceConsumed: sequence },
	};
}

function createHarness(
	overrides: {
		descriptor?: WorkerUnitDescriptor;
		modelPolicyFingerprint?: string | null;
		currentExecution?: ProcessInstance["currentExecution"];
	} = {},
) {
	const descriptor = overrides.descriptor ?? {
		instanceId: "proc-1",
		workerId: "wkr-1",
		unitId: "unit-1",
	};
	const lease = {
		id: "lease-1",
		instanceId: "proc-1",
		workerId: "wkr-1",
		state: "busy" as const,
		serverEpoch: "epoch-old",
		connectTokenHash: "hash",
		snapshotTokenHash: null,
		modelPolicyFingerprint:
			overrides.modelPolicyFingerprint === undefined
				? "current-model-policy"
				: overrides.modelPolicyFingerprint,
		lastHeartbeatAt: null,
		startedAt: new Date(0).toISOString(),
		exitedAt: null,
	};
	const process = {
		id: "proc-1",
		processId: "test_process",
		selectedTurnId: "turn",
		lifecycleStatus: "active" as const,
		stateJson: {},
		metadata: {},
		currentExecution:
			overrides.currentExecution === undefined
				? ({ kind: "worker_start", id: "start-1" } as const)
				: overrides.currentExecution,
		title: "test",
		createdAt: new Date(0).toISOString(),
		updatedAt: new Date(0).toISOString(),
		closedAt: null,
		planRevision: 0,
	};
	let registered: Parameters<WorkerWebSocketIpcManager["registerWorker"]>[0] | undefined;
	const webSocketIpc = {
		registerWorker: vi.fn((input) => {
			registered = input;
		}),
		unregister: vi.fn(),
	} as unknown as WorkerWebSocketIpcManager;
	const runner = {
		list: vi.fn(async () => [descriptor]),
		adopt: vi.fn(async (candidate: WorkerUnitDescriptor) => unit(candidate)),
		stop: vi.fn(),
	};
	const unitReclaimer = createWorkerUnitReclaimer({
		runner,
		retry: { initialDelayMs: 1, maxDelayMs: 1 },
	});
	const workers = new Map<string, WorkerHandle>();
	const createdHandles: WorkerHandle[] = [];
	const routeEnvelope = vi.fn();
	const emitServerObservedWorkerFailure = vi.fn();
	const sendInputBatch = vi.fn(() => true);
	const modelPolicyFingerprintForProcess = vi.fn(() => "current-model-policy");
	const leases = {
		update: vi.fn(),
	} as unknown as RepositoryBundle["leases"];
	const inputs = {
		listUnconsumed: vi.fn(() => []),
		markConsumed: vi.fn(),
	} as unknown as RepositoryBundle["inputs"];
	const coordinator = createWorkerAdoptionCoordinator({
		startupTimeoutMs: 30_000,
		serverEpoch: "epoch-new",
		adoptionRetry: { maxAttempts: 2, delayMs: 1, sleep: vi.fn(async () => {}) },
		runnerRuntime: { runner, webSocketIpc },
		unitReclaimer,
		workers,
		leases,
		inputs,
		safeGetLeaseByInstance: () => lease,
		safeGetProcessById: () => process,
		modelPolicyFingerprintForProcess,
		isLeaseStillBootstrapping: () => false,
		routeEnvelope,
		handleProcessError: vi.fn(),
		emitServerObservedWorkerFailure,
		createRunnerHandle: ({ unit: workerUnit }) => {
			const workerHandle = handle(workerUnit);
			createdHandles.push(workerHandle);
			return workerHandle;
		},
		sendInputBatch,
	});
	return {
		coordinator,
		descriptor,
		runner,
		unitReclaimer,
		webSocketIpc,
		workers,
		createdHandles,
		routeEnvelope,
		emitServerObservedWorkerFailure,
		inputs,
		sendInputBatch,
		modelPolicyFingerprintForProcess,
		get registered() {
			return registered;
		},
	};
}

describe("createWorkerAdoptionCoordinator", () => {
	it("keeps a timed-out adopted worker attached until its physical exit handoff", async () => {
		vi.useFakeTimers();
		try {
			const harness = createHarness();
			await harness.coordinator.adoptRegisteredWorkers();
			const adopted = harness.workers.get("proc-1");
			await vi.advanceTimersByTimeAsync(30_000);
			expect(adopted?.kill).toHaveBeenCalledWith("SIGKILL");
			expect(harness.coordinator.isPending("proc-1")).toBe(false);
			expect(harness.workers.get("proc-1")).toBe(adopted);
		} finally {
			vi.useRealTimers();
		}
	});

	it("buffers early reconnect envelopes until the adopted unit is attached", async () => {
		const harness = createHarness();
		harness.runner.adopt.mockImplementationOnce(async (candidate) => {
			expect(harness.routeEnvelope).not.toHaveBeenCalled();
			harness.registered?.callbacks.onEnvelope(heartbeat());
			expect(harness.routeEnvelope).not.toHaveBeenCalled();
			return unit(candidate);
		});

		await harness.coordinator.adoptRegisteredWorkers();

		expect(harness.workers.get("proc-1")?.workerId).toBe("wkr-1");
		expect(harness.routeEnvelope).toHaveBeenCalledWith(
			expect.objectContaining({ messageId: "hb-1" }),
			"proc-1",
		);
		expect(harness.coordinator.isPending("proc-1")).toBe(true);
	});

	it("acknowledges already-consumed inputs and redelivers newer inputs from reconnect heartbeats", async () => {
		const harness = createHarness();
		vi.mocked(harness.inputs.listUnconsumed).mockReturnValue([
			input("inp-1", 1),
			input("inp-2", 2),
			input("inp-3", 3),
		]);

		await harness.coordinator.adoptRegisteredWorkers();
		harness.coordinator.onHeartbeat("proc-1", "wkr-1", { lastSequenceConsumed: 2 });

		expect(harness.inputs.markConsumed).toHaveBeenCalledWith("inp-1");
		expect(harness.inputs.markConsumed).toHaveBeenCalledWith("inp-2");
		expect(harness.sendInputBatch).toHaveBeenCalledWith("proc-1", harness.workers.get("proc-1"), [
			expect.objectContaining({ inputId: "inp-3", sequence: 3 }),
		]);
		expect(harness.coordinator.isPending("proc-1")).toBe(false);
	});

	it("ignores invalid reconnect heartbeat consumption positions", async () => {
		const harness = createHarness();

		await harness.coordinator.adoptRegisteredWorkers();
		harness.coordinator.onHeartbeat("proc-1", "wkr-1", { lastSequenceConsumed: 1.5 });

		expect(harness.inputs.listUnconsumed).not.toHaveBeenCalled();
		expect(harness.coordinator.isPending("proc-1")).toBe(true);
	});

	it("cleans up attached state when replaying early envelopes fails", async () => {
		const harness = createHarness();
		harness.runner.adopt.mockImplementationOnce(async (candidate) => {
			harness.registered?.callbacks.onEnvelope(heartbeat());
			return unit(candidate);
		});
		harness.routeEnvelope.mockImplementationOnce(() => {
			throw new Error("route failed");
		});

		await harness.coordinator.adoptRegisteredWorkers();

		expect(harness.workers.has("proc-1")).toBe(false);
		expect(harness.coordinator.isPending("proc-1")).toBe(false);
		expect(harness.webSocketIpc.unregister).toHaveBeenCalledWith(
			"proc-1",
			"wkr-1",
			"adoption_failed",
		);
		expect(harness.createdHandles[0]?.detach).toHaveBeenCalledWith("adoption_failed");
		expect(harness.emitServerObservedWorkerFailure).toHaveBeenCalledWith("proc-1", "wkr-1", {
			errorCode: "worker_adoption_failed",
			message: "Worker adoption failed: route failed",
			errorClass: "infrastructure",
		});
		expect(harness.runner.stop).toHaveBeenCalledWith(harness.descriptor, { graceMs: 0 });
	});

	it("stops workers whose lease was created for a different model policy", async () => {
		const harness = createHarness({ modelPolicyFingerprint: "previous-model-policy" });

		await harness.coordinator.adoptRegisteredWorkers();

		expect(harness.runner.adopt).not.toHaveBeenCalled();
		expect(harness.runner.stop).toHaveBeenCalledWith(harness.descriptor, { graceMs: 0 });
		expect(harness.workers.has("proc-1")).toBe(false);
	});

	it("stops terminal descriptors even when their lease is active", async () => {
		const harness = createHarness({
			descriptor: {
				instanceId: "proc-1",
				workerId: "wkr-1",
				unitId: "unit-1",
				observedState: "terminal",
			},
		});

		await harness.coordinator.adoptRegisteredWorkers();

		expect(harness.runner.adopt).not.toHaveBeenCalled();
		expect(harness.runner.stop).toHaveBeenCalledWith(
			expect.objectContaining({ observedState: "terminal" }),
			{ graceMs: 0 },
		);
		expect(harness.modelPolicyFingerprintForProcess).not.toHaveBeenCalled();
	});

	it("stops live descriptors when the process no longer has a current worker start", async () => {
		const harness = createHarness({ currentExecution: null });

		await harness.coordinator.adoptRegisteredWorkers();

		expect(harness.modelPolicyFingerprintForProcess).not.toHaveBeenCalled();
		expect(harness.runner.adopt).not.toHaveBeenCalled();
		expect(harness.runner.stop).toHaveBeenCalledWith(harness.descriptor, { graceMs: 0 });
	});

	it("retries transient runner adoption failures before giving up", async () => {
		const harness = createHarness();
		harness.runner.adopt.mockRejectedValueOnce(new Error("runtime adoption failed"));

		await harness.coordinator.adoptRegisteredWorkers();

		expect(harness.runner.adopt).toHaveBeenCalledTimes(2);
		expect(harness.runner.stop).not.toHaveBeenCalled();
		expect(harness.emitServerObservedWorkerFailure).not.toHaveBeenCalled();
		expect(harness.workers.get("proc-1")?.workerId).toBe("wkr-1");
	});

	it("stops the old unit when runner adoption retries are exhausted", async () => {
		const harness = createHarness();
		harness.runner.adopt.mockRejectedValue(new Error("runtime adoption unavailable"));

		await harness.coordinator.adoptRegisteredWorkers();

		expect(harness.runner.adopt).toHaveBeenCalledTimes(2);
		expect(harness.webSocketIpc.unregister).toHaveBeenCalledWith(
			"proc-1",
			"wkr-1",
			"adoption_failed",
		);
		expect(harness.emitServerObservedWorkerFailure).not.toHaveBeenCalled();
		expect(harness.runner.stop).toHaveBeenCalledWith(harness.descriptor, { graceMs: 0 });
		expect(harness.workers.has("proc-1")).toBe(false);
	});

	it("stops duplicate live descriptors after attaching one unit for a lease", async () => {
		const harness = createHarness();
		const duplicate = { ...harness.descriptor, unitId: "unit-2" };
		harness.runner.list.mockResolvedValueOnce([harness.descriptor, duplicate]);

		await harness.coordinator.adoptRegisteredWorkers();

		expect(harness.runner.adopt).toHaveBeenCalledTimes(1);
		expect(harness.runner.adopt).toHaveBeenCalledWith(harness.descriptor);
		expect(harness.runner.stop).toHaveBeenCalledWith(duplicate, { graceMs: 0 });
		expect(harness.workers.get("proc-1")?.workerId).toBe("wkr-1");
	});

	it("continues adoption when stale cleanup fails and retries cleanup in the background", async () => {
		const harness = createHarness();
		const stale = {
			...harness.descriptor,
			unitId: "unit-stale",
			observedState: "terminal" as const,
		};
		harness.runner.list.mockResolvedValueOnce([stale, harness.descriptor]);
		harness.runner.stop
			.mockRejectedValueOnce(new Error("runtime cleanup unavailable"))
			.mockResolvedValue(undefined);

		await expect(harness.coordinator.adoptRegisteredWorkers()).resolves.toBeUndefined();

		expect(harness.runner.adopt).toHaveBeenCalledWith(harness.descriptor);
		expect(harness.workers.get("proc-1")?.workerId).toBe("wkr-1");
		await vi.waitFor(() => expect(harness.runner.stop).toHaveBeenCalledTimes(2));
		expect(harness.unitReclaimer.staleResourceBacklogCount()).toBe(0);
	});
});
