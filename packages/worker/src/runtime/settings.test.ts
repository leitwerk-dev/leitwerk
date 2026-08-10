import type { WorkerStartPayload } from "@leitwerk-dev/worker-protocol";
import { describe, expect, it } from "vitest";
import { resolveWorkerRuntimeSettings } from "./settings.js";

describe("resolveWorkerRuntimeSettings", () => {
	it("uses server-supplied runtime settings for automatic workers", () => {
		const payload = {
			bootstrap: { kind: "automatic" },
			workerRuntimeSettings: {
				heartbeat_interval: "5s",
				turn_max_duration: "6h",
				turn_inactivity_timeout: "10m",
				turn_abort_grace_period: "10s",
			},
		} as WorkerStartPayload;

		expect(resolveWorkerRuntimeSettings({} as never, payload)).toEqual({
			heartbeatIntervalMs: 5_000,
			turnMaxDurationMs: 6 * 60 * 60_000,
			turnInactivityTimeoutMs: 10 * 60_000,
			turnAbortGracePeriodMs: 10_000,
		});
	});

	it("keeps the legacy automatic-worker defaults when settings are absent", () => {
		const payload = { bootstrap: { kind: "automatic" } } as WorkerStartPayload;

		expect(resolveWorkerRuntimeSettings({} as never, payload)).toEqual({
			heartbeatIntervalMs: 30_000,
			turnMaxDurationMs: 30 * 60_000,
			turnInactivityTimeoutMs: 5 * 60_000,
			turnAbortGracePeriodMs: 5_000,
		});
	});

	it("lets explicit worker entrypoint overrides win", () => {
		const payload = {
			bootstrap: { kind: "automatic" },
			workerRuntimeSettings: {
				heartbeat_interval: "5s",
				turn_max_duration: "6h",
				turn_inactivity_timeout: "10m",
				turn_abort_grace_period: "10s",
			},
		} as WorkerStartPayload;

		expect(
			resolveWorkerRuntimeSettings({ heartbeatIntervalMs: 1_000 } as never, payload),
		).toMatchObject({ heartbeatIntervalMs: 1_000 });
	});
});
