import type { WorkerHandle, WorkerSupervisor } from "../supervisor/worker-supervisor.js";

export interface FakeWorkerSupervisor extends WorkerSupervisor {
	spawnCalls: string[];
	stopCalls: Array<{ instanceId: string; reason: string }>;
	callLog: string[];
}

interface FakeWorkerSupervisorOptions {
	stopWorker?: (instanceId: string, reason: string) => Promise<void> | void;
}

function createFakeWorkerHandle(instanceId: string, suffix = ""): WorkerHandle {
	return {
		workerId: `wkr_${instanceId}${suffix}`,
		instanceId,
		send() {},
		kill() {},
		detach() {},
		onceExit() {},
	};
}

export function createFakeWorkerSupervisor(
	initialWorkerInstanceIds: readonly string[] = [],
	options: FakeWorkerSupervisorOptions = {},
): FakeWorkerSupervisor {
	const workers = new Map<string, WorkerHandle>();
	const spawnCalls: string[] = [];
	const stopCalls: Array<{ instanceId: string; reason: string }> = [];
	const callLog: string[] = [];

	for (const instanceId of initialWorkerInstanceIds) {
		workers.set(instanceId, createFakeWorkerHandle(instanceId));
	}

	return {
		async spawnWorker(instanceId) {
			spawnCalls.push(instanceId);
			callLog.push(`spawn:${instanceId}`);
			const handle = createFakeWorkerHandle(instanceId, `_${spawnCalls.length}`);
			workers.set(instanceId, handle);
			return handle;
		},
		async stopWorker(instanceId, reason) {
			stopCalls.push({ instanceId, reason });
			callLog.push(`stop:${instanceId}:${reason}`);
			if (options.stopWorker) {
				await options.stopWorker(instanceId, reason);
				return;
			}
			workers.delete(instanceId);
		},
		abortTurn() {},
		deliverInputs() {},
		acceptTurnStart() {},
		acknowledgeTurnTerminal() {},
		questionResponse() {},
		integrationToolResult() {},
		credentialUpdateResult() {},
		getWorker(instanceId) {
			return workers.get(instanceId);
		},
		isAdoptionPending() {
			return false;
		},
		async adoptRegisteredWorkers() {},
		async detachAll() {
			workers.clear();
		},
		async shutdownAll() {
			workers.clear();
		},
		spawnCalls,
		stopCalls,
		callLog,
	};
}
