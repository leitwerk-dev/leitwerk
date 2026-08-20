import { parseDurationMs } from "@leitwerk-dev/watcher-utils";
import type { RepositoryBundle } from "../db/repositories.js";
import { resolveAcceptedTurnStartReplay } from "./accepted-turn-start-replay.js";
import type { IpcHandler } from "./ipc-handler.js";
import { createServerObservedWorkerFailedMessage } from "./synthetic-worker-failure.js";
import type { WorkerSupervisor } from "./worker-supervisor.js";

export interface StaleHeartbeatWatchdogDeps
	extends Pick<RepositoryBundle, "leases" | "processes" | "turnRecords" | "turnStarts"> {
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
	const acceptedStartReconciliations = new Map<
		string,
		{ turnRecordId: string; startedAtMs: number }
	>();

	const tick = () => {
		const observedReconciliations = new Set<string>();
		for (const lease of deps.leases.listActive()) {
			if (deps.supervisor.isAdoptionPending?.(lease.instanceId)) {
				continue;
			}
			if (lease.state !== "idle" && lease.state !== "busy" && lease.state !== "draining") {
				continue;
			}
			const process = deps.processes.getById(lease.instanceId);
			if (!process) {
				continue;
			}

			const acceptedStart =
				lease.state === "idle"
					? resolveAcceptedTurnStartReplay(deps, lease.instanceId, lease.workerId)
					: null;
			const acceptedAtMs = acceptedStart ? Date.parse(acceptedStart.startedAt) : Number.NaN;
			if (acceptedStart && Number.isFinite(acceptedAtMs) && now() - acceptedAtMs >= timeoutMs) {
				observedReconciliations.add(lease.instanceId);
				const reconciliation = acceptedStartReconciliations.get(lease.instanceId);
				if (!reconciliation || reconciliation.turnRecordId !== acceptedStart.turnRecordId) {
					if (deps.supervisor.reconcileAcceptedTurnStart(lease.instanceId, lease.workerId)) {
						acceptedStartReconciliations.set(lease.instanceId, {
							turnRecordId: acceptedStart.turnRecordId,
							startedAtMs: now(),
						});
						continue;
					}
				} else if (now() - reconciliation.startedAtMs < timeoutMs) {
					continue;
				}
				acceptedStartReconciliations.delete(lease.instanceId);
				deps.ipcHandler.handleMessage(
					createServerObservedWorkerFailedMessage({
						instanceId: lease.instanceId,
						workerId: lease.workerId,
						state: lease.state,
						errorCode: "idle_worker_running_turn",
						message: `Worker ${lease.workerId} reported idle while turn ${acceptedStart.turnRecordId} remained running`,
						errorClass: "infrastructure",
						selectedTurnId: process.selectedTurnId,
					}),
				);
				deps.supervisor.getWorker(lease.instanceId)?.kill();
				continue;
			}

			if (!lease.lastHeartbeatAt) {
				continue;
			}
			const lastSeenMs = Date.parse(lease.lastHeartbeatAt);
			if (!Number.isFinite(lastSeenMs) || now() - lastSeenMs < timeoutMs) {
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
		for (const instanceId of acceptedStartReconciliations.keys()) {
			if (!observedReconciliations.has(instanceId)) {
				acceptedStartReconciliations.delete(instanceId);
			}
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
