import { parseDurationMs } from "@leitwerk-dev/watcher-utils";
import type { WorkerStartPayload } from "@leitwerk-dev/worker-protocol";
import { isLlmWorkerStartPayload } from "../worker-start-payload.js";
import type { WorkerRuntimeConfig } from "./adapters.js";

const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_TURN_MAX_DURATION_MS = 30 * 60_000;
const DEFAULT_TURN_INACTIVITY_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_TURN_ABORT_GRACE_PERIOD_MS = 5_000;

export interface WorkerRuntimeSettings {
	heartbeatIntervalMs: number;
	turnMaxDurationMs: number;
	turnInactivityTimeoutMs: number;
	turnAbortGracePeriodMs: number;
}

function duration(value: string | undefined, fallback: number): number {
	return value ? parseDurationMs(value, fallback, { allowHours: true }) : fallback;
}

/** Resolves immutable runtime settings at the worker.start boundary. */
export function resolveWorkerRuntimeSettings(
	config: WorkerRuntimeConfig,
	payload: WorkerStartPayload,
): WorkerRuntimeSettings {
	const workers =
		payload.workerRuntimeSettings ??
		(isLlmWorkerStartPayload(payload) ? payload.configSnapshot.workers : null);
	return {
		heartbeatIntervalMs:
			config.heartbeatIntervalMs ?? duration(workers?.heartbeat_interval, DEFAULT_HEARTBEAT_MS),
		turnMaxDurationMs:
			config.turnMaxDurationMs ??
			duration(workers?.turn_max_duration, DEFAULT_TURN_MAX_DURATION_MS),
		turnInactivityTimeoutMs:
			config.turnInactivityTimeoutMs ??
			duration(workers?.turn_inactivity_timeout, DEFAULT_TURN_INACTIVITY_TIMEOUT_MS),
		turnAbortGracePeriodMs:
			config.turnAbortGracePeriodMs ??
			duration(workers?.turn_abort_grace_period, DEFAULT_TURN_ABORT_GRACE_PERIOD_MS),
	};
}
