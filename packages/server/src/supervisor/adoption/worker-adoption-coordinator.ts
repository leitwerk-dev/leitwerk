import type { ProcessInstance } from "@leitwerk-dev/domain";
import type { InputDelivery, IpcEnvelope } from "@leitwerk-dev/worker-protocol";
import type { WorkerUnit, WorkerUnitDescriptor } from "@leitwerk-dev/worker-runners/types";
import type { RepositoryBundle } from "../../db/repositories.js";
import { toInputDelivery } from "../../process-input-dispatch.js";
import type { WorkerHandle } from "../worker-supervisor.js";
import type { WorkerUnitReclaimer } from "../worker-unit-reclaimer.js";
import type { WorkerWebSocketIpcManager } from "../worker-websocket-ipc.js";
import { classifyWorkerDescriptor, workerDescriptorKey } from "./adoption-plan.js";

export interface WorkerAdoptionCoordinatorDeps {
	startupTimeoutMs: number;
	serverEpoch: string;
	adoptionRetry?: {
		maxAttempts?: number;
		delayMs?: number;
		sleep?: (ms: number) => Promise<void>;
	};
	runnerRuntime: {
		runner: {
			list(): Promise<WorkerUnitDescriptor[]>;
			adopt(descriptor: WorkerUnitDescriptor): Promise<WorkerUnit>;
		};
		webSocketIpc: WorkerWebSocketIpcManager;
	};
	unitReclaimer: WorkerUnitReclaimer;
	workers: Map<string, WorkerHandle>;
	leases: Pick<RepositoryBundle["leases"], "update">;
	inputs: Pick<RepositoryBundle["inputs"], "listUnconsumed" | "markConsumed">;
	safeGetLeaseByInstance(
		instanceId: string,
	): ReturnType<RepositoryBundle["leases"]["getByInstance"]>;
	safeGetProcessById(instanceId: string): ReturnType<RepositoryBundle["processes"]["getById"]>;
	modelPolicyFingerprintForProcess(process: ProcessInstance): string;
	isLeaseStillBootstrapping(instanceId: string, workerId: string): boolean;
	routeEnvelope(envelope: IpcEnvelope, instanceId: string): void;
	handleProcessError(instanceId: string, workerId: string, error: unknown): void;
	emitServerObservedWorkerFailure(
		instanceId: string,
		workerId: string,
		payload: { errorCode: string; message: string; errorClass?: string },
	): void;
	createRunnerHandle(input: { unit: WorkerUnit; unregister(reason: string): void }): WorkerHandle;
	sendInputBatch(instanceId: string, handle: WorkerHandle, inputs: InputDelivery[]): boolean;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function attachedWorkerDescriptorKey(handle: WorkerHandle | undefined): string | null {
	return handle?.unitId ? `${handle.namespace ?? ""}/${handle.unitId}` : null;
}

function parseLastSequenceConsumed(payload: unknown): number | null {
	if (typeof payload !== "object" || payload === null) return null;
	const raw = (payload as { lastSequenceConsumed?: unknown }).lastSequenceConsumed;
	return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : null;
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
	});
}

export function createWorkerAdoptionCoordinator(deps: WorkerAdoptionCoordinatorDeps) {
	const pending = new Set<string>();
	const timers = new Map<string, ReturnType<typeof setTimeout>>();
	const retryMaxAttempts = Math.max(1, deps.adoptionRetry?.maxAttempts ?? 3);
	const retryDelayMs = Math.max(0, deps.adoptionRetry?.delayMs ?? 250);
	const sleep = deps.adoptionRetry?.sleep ?? defaultSleep;

	function clearTimer(instanceId: string): void {
		const timer = timers.get(instanceId);
		if (timer) clearTimeout(timer);
		timers.delete(instanceId);
	}

	function clear(instanceId: string): boolean {
		const wasPending = pending.delete(instanceId);
		clearTimer(instanceId);
		return wasPending;
	}

	function startTimeout(instanceId: string, handle: WorkerHandle): void {
		clearTimer(instanceId);
		const timer = setTimeout(() => {
			timers.delete(instanceId);
			if (!pending.delete(instanceId)) {
				return;
			}
			deps.workers.delete(instanceId);
			const lease = deps.safeGetLeaseByInstance(instanceId);
			if (lease?.workerId === handle.workerId) {
				deps.emitServerObservedWorkerFailure(instanceId, handle.workerId, {
					errorCode: "startup_timeout",
					message: `Adopted worker startup timed out after ${deps.startupTimeoutMs}ms`,
					errorClass: "infrastructure",
				});
				handle.kill("SIGKILL");
				return;
			}
			handle.detach("adoption_timeout");
		}, deps.startupTimeoutMs);
		timers.set(instanceId, timer);
	}

	function registerWebSocket(input: {
		instanceId: string;
		workerId: string;
		tokenHash: string;
		onEnvelope(envelope: IpcEnvelope): void;
	}): { unregister(reason: string): void } {
		deps.runnerRuntime.webSocketIpc.registerWorker({
			instanceId: input.instanceId,
			workerId: input.workerId,
			tokenHash: input.tokenHash,
			callbacks: {
				onEnvelope: input.onEnvelope,
				onInvalidOutput: () => {
					deps.emitServerObservedWorkerFailure(input.instanceId, input.workerId, {
						errorCode: "invalid_worker_websocket_ipc",
						message: "Adopted worker emitted invalid IPC output",
						errorClass: "infrastructure",
					});
				},
				onRuntimeError: (error) => deps.handleProcessError(input.instanceId, input.workerId, error),
			},
		});
		return {
			unregister(reason: string) {
				deps.runnerRuntime.webSocketIpc.unregister(input.instanceId, input.workerId, reason);
			},
		};
	}

	function cleanupAttachedAdoptionFailure(input: {
		instanceId: string;
		detach?: (reason: string) => void;
		unregister(reason: string): void;
	}): void {
		deps.workers.delete(input.instanceId);
		clear(input.instanceId);
		input.unregister("adoption_failed");
		input.detach?.("adoption_failed");
	}

	async function adoptWithRetry(descriptor: WorkerUnitDescriptor): Promise<WorkerUnit> {
		let lastError: unknown;
		for (let attempt = 1; attempt <= retryMaxAttempts; attempt += 1) {
			try {
				return await deps.runnerRuntime.runner.adopt(descriptor);
			} catch (error) {
				lastError = error;
				if (attempt < retryMaxAttempts) {
					await sleep(retryDelayMs);
				}
			}
		}
		throw lastError;
	}

	return {
		isPending(instanceId: string): boolean {
			return pending.has(instanceId);
		},
		clear,
		onWorkerReady(instanceId: string): void {
			clear(instanceId);
		},
		onHeartbeat(instanceId: string, workerId: string, payload: unknown): void {
			if (!pending.has(instanceId)) {
				return;
			}
			const lastSequenceConsumed = parseLastSequenceConsumed(payload);
			if (lastSequenceConsumed === null) {
				return;
			}
			const handle = deps.workers.get(instanceId);
			if (!handle || handle.workerId !== workerId) {
				return;
			}
			const deliverInputs: InputDelivery[] = [];
			for (const input of deps.inputs.listUnconsumed(instanceId)) {
				if (input.sequence <= lastSequenceConsumed) {
					deps.inputs.markConsumed(input.id);
				} else {
					deliverInputs.push(toInputDelivery(input));
				}
			}
			deps.sendInputBatch(instanceId, handle, deliverInputs);
			if (!deps.isLeaseStillBootstrapping(instanceId, workerId)) {
				clear(instanceId);
			}
		},
		async adoptRegisteredWorkers(): Promise<void> {
			const descriptors = await deps.runnerRuntime.runner.list();
			const adopted = new Set<string>();
			const stopStale: WorkerUnitDescriptor[] = [];
			const failedAdoptions: WorkerUnitDescriptor[] = [];
			for (const descriptor of descriptors) {
				const lease = deps.safeGetLeaseByInstance(descriptor.instanceId);
				const process = deps.safeGetProcessById(descriptor.instanceId);
				const canAdoptCurrentWorker =
					descriptor.observedState !== "terminal" &&
					process?.currentExecution?.kind === "worker_start";
				const classification = classifyWorkerDescriptor({
					descriptor,
					process,
					lease,
					expectedModelPolicyFingerprint: canAdoptCurrentWorker
						? deps.modelPolicyFingerprintForProcess(process)
						: "",
					alreadyAttached: deps.workers.has(descriptor.instanceId),
					attachedDescriptorKey: attachedWorkerDescriptorKey(
						deps.workers.get(descriptor.instanceId),
					),
				});
				if (classification === "stop_stale") {
					stopStale.push(descriptor);
					continue;
				}
				if (classification !== "adopt" || !lease?.connectTokenHash) {
					continue;
				}

				let attached = false;
				let adoptedUnit: WorkerUnit | null = null;
				let handle: WorkerHandle | null = null;
				const earlyEnvelopes: IpcEnvelope[] = [];
				const connect = registerWebSocket({
					instanceId: descriptor.instanceId,
					workerId: descriptor.workerId,
					tokenHash: lease.connectTokenHash,
					onEnvelope: (envelope) => {
						if (attached) {
							deps.routeEnvelope(envelope, descriptor.instanceId);
						} else {
							earlyEnvelopes.push(envelope);
						}
					},
				});
				try {
					adoptedUnit = await adoptWithRetry(descriptor);
					const latestLease = deps.safeGetLeaseByInstance(descriptor.instanceId);
					if (latestLease?.workerId === descriptor.workerId) {
						deps.leases.update(latestLease.id, { serverEpoch: deps.serverEpoch });
					}
					handle = deps.createRunnerHandle({ unit: adoptedUnit, unregister: connect.unregister });
					deps.workers.set(descriptor.instanceId, handle);
					pending.add(descriptor.instanceId);
					const key = workerDescriptorKey(descriptor);
					startTimeout(descriptor.instanceId, handle);
					attached = true;
					for (const envelope of earlyEnvelopes) {
						deps.routeEnvelope(envelope, descriptor.instanceId);
					}
					adopted.add(key);
				} catch (error) {
					if (!adoptedUnit) {
						connect.unregister("adoption_failed");
						failedAdoptions.push(descriptor);
						continue;
					}
					cleanupAttachedAdoptionFailure({
						instanceId: descriptor.instanceId,
						detach: handle?.detach,
						unregister: connect.unregister,
					});
					failedAdoptions.push(descriptor);
					deps.emitServerObservedWorkerFailure(descriptor.instanceId, descriptor.workerId, {
						errorCode: "worker_adoption_failed",
						message: `Worker adoption failed: ${errorMessage(error)}`,
						errorClass: "infrastructure",
					});
				}
			}
			for (const descriptor of stopStale) {
				if (adopted.has(workerDescriptorKey(descriptor))) continue;
				void deps.unitReclaimer.reclaim(descriptor, "startup_stale");
			}
			for (const descriptor of failedAdoptions) {
				if (adopted.has(workerDescriptorKey(descriptor))) continue;
				void deps.unitReclaimer.reclaim(descriptor, "adoption_failed");
			}
		},
	};
}

export type WorkerAdoptionCoordinator = ReturnType<typeof createWorkerAdoptionCoordinator>;
