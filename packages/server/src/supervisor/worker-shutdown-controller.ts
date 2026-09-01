import { randomUUID } from "node:crypto";
import { parseDurationMs } from "@leitwerk-dev/watcher-utils";
import { createIpcMessage, type ServerToWorkerMessage } from "@leitwerk-dev/worker-protocol";
import type { LeitwerkConfig } from "../config/config-types.js";
import type { ApplyWorkerLeaseObservationResult } from "./worker-lease-observer.js";
import type { WorkerHandle } from "./worker-supervisor.js";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopPhysicalRuntime(
	handle: WorkerHandle,
	signal: NodeJS.Signals | number,
): Promise<void> {
	if (handle.killAndWait) {
		await handle.killAndWait(signal);
		return;
	}
	handle.kill(signal);
}

export function createWorkerShutdownController(input: {
	config: LeitwerkConfig;
	workers: Map<string, WorkerHandle>;
	pendingCleanup: Map<string, () => void>;
	observeWorkerLease(
		instanceId: string,
		workerId: string,
		observation: "stop_requested" | "process_exited" | "failure_reported",
		reason?: string,
	): ApplyWorkerLeaseObservationResult;
	getLeaseByInstance?(instanceId: string): { workerId: string; state: string } | null | undefined;
}) {
	return {
		async stopWorker(instanceId: string, reason: string): Promise<void> {
			const handle = input.workers.get(instanceId);
			if (!handle) {
				return;
			}
			const leaseBeforeStop = input.getLeaseByInstance?.(instanceId);
			input.observeWorkerLease(instanceId, handle.workerId, "stop_requested", reason);
			const exitPromise = new Promise<"exit">((resolve) => {
				handle.onceExit(() => resolve("exit"));
			});
			if (leaseBeforeStop?.workerId === handle.workerId && leaseBeforeStop.state === "spawning") {
				await stopPhysicalRuntime(handle, "SIGKILL");
				await exitPromise;
				return;
			}
			const msg = createIpcMessage<ServerToWorkerMessage>({
				type: "worker.stop",
				instanceId,
				workerId: handle.workerId,
				messageId: randomUUID(),
				payload: { reason },
			});
			handle.send(msg);

			const graceMs = parseDurationMs(input.config.workers.shutdown_grace_period, 30_000, {
				allowHours: true,
			});
			const deadline = Date.now() + graceMs;
			const cleanupPromise = new Promise<"cleanup">((resolve) => {
				input.pendingCleanup.set(instanceId, () => resolve("cleanup"));
			});
			const waitForExit = async (): Promise<"exit" | "timeout"> => {
				const remainingMs = Math.max(0, deadline - Date.now());
				return Promise.race([exitPromise, sleep(remainingMs).then(() => "timeout" as const)]);
			};

			try {
				const firstResult = await Promise.race([
					cleanupPromise,
					exitPromise,
					sleep(graceMs).then(() => "timeout" as const),
				]);
				if (firstResult === "cleanup") {
					const exitResult = await waitForExit();
					if (exitResult === "timeout" && input.workers.has(instanceId)) {
						await stopPhysicalRuntime(handle, "SIGKILL");
						await exitPromise;
					}
					return;
				}
				if (firstResult === "timeout" && input.workers.has(instanceId)) {
					await stopPhysicalRuntime(handle, "SIGKILL");
					await exitPromise;
				}
			} finally {
				input.pendingCleanup.delete(instanceId);
			}
		},
	};
}
