import { parseDurationMs } from "@leitwerk-dev/watcher-utils";
import type { RepositoryBundle } from "../db/repositories.js";
import type { IpcHandler } from "./ipc-handler.js";
import { createServerObservedWorkerFailedMessage } from "./synthetic-worker-failure.js";
import type { WorkerSupervisor } from "./worker-supervisor.js";

export interface StaleHeartbeatWatchdogDeps extends Pick<RepositoryBundle, "leases" | "processes"> {
	ipcHandler: IpcHandler;
	supervisor: WorkerSupervisor;
	staleHeartbeatTimeout: string;
	checkIntervalMs?: number;
	now?: () => number;
	setIntervalImpl?: typeof setInterval;
	clearIntervalImpl?: typeof clearInterval;
}

export interface StaleHeartbeatWatchdogHandle {
	stop(): void;
	tick(): void;
}

export function startStaleHeartbeatWatchdog(
	deps: StaleHeartbeatWatchdogDeps,
): StaleHeartbeatWatchdogHandle {
	const timeoutMs = parseDurationMs(deps.staleHeartbeatTimeout, 30_000, { allowHours: true });
	const intervalMs = deps.checkIntervalMs ?? Math.max(1_000, Math.min(timeoutMs, 5_000));
	const now = deps.now ?? (() => Date.now());
	const setIntervalImpl = deps.setIntervalImpl ?? setInterval;
	const clearIntervalImpl = deps.clearIntervalImpl ?? clearInterval;

	const tick = () => {
		for (const lease of deps.leases.listActive()) {
			if (deps.supervisor.isAdoptionPending?.(lease.instanceId)) {
				continue;
			}
			if (lease.state !== "idle" && lease.state !== "busy" && lease.state !== "draining") {
				continue;
			}
			const heartbeatAt = lease.lastHeartbeatAt ?? lease.startedAt;
			const lastSeenMs = Date.parse(heartbeatAt);
			if (!Number.isFinite(lastSeenMs) || now() - lastSeenMs < timeoutMs) {
				continue;
			}

			const process = deps.processes.getById(lease.instanceId);
			if (!process) {
				continue;
			}

			deps.ipcHandler.handleMessage(
				createServerObservedWorkerFailedMessage({
					instanceId: lease.instanceId,
					workerId: lease.workerId,
					state: lease.state,
					errorCode: "stale_heartbeat_timeout",
					message: `Worker heartbeat stale for ${lease.workerId} after ${timeoutMs}ms`,
					errorClass: "infrastructure",
					selectedTurnId: process.selectedTurnId,
				}),
			);
			deps.supervisor.getWorker(lease.instanceId)?.kill();
		}
	};

	const timer = setIntervalImpl(tick, intervalMs);
	return {
		stop() {
			clearIntervalImpl(timer);
		},
		tick,
	};
}
