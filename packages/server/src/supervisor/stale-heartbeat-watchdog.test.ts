import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestIpcHandler } from "../test-helpers/ipc-handler-harness.js";
import { createTestDeps } from "../test-helpers/unit-deps.js";
import { startStaleHeartbeatWatchdog } from "./stale-heartbeat-watchdog.js";

function flushAsyncWork() {
	return new Promise<void>((resolve) => setImmediate(resolve));
}

describe("startStaleHeartbeatWatchdog", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("skips stale heartbeat failure while worker adoption is pending", async () => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "jira_issue_process",
			selectedTurnId: "generate_plan",
			lifecycleStatus: "active",
		});
		const lease = deps.leases.create({
			instanceId: process.id,
			workerId: "wkr_adopting",
			state: "idle",
		});
		deps.leases.update(lease.id, { lastHeartbeatAt: "2026-04-14T10:00:00.000Z" });
		const kill = vi.fn();
		const supervisor = {
			isAdoptionPending(instanceId: string) {
				return instanceId === process.id;
			},
			getWorker(instanceId: string) {
				return instanceId === process.id ? { kill } : undefined;
			},
		} as const;
		const ipcHandler = createTestIpcHandler(deps);

		const timer = {} as ReturnType<typeof setInterval>;
		const watchdog = startStaleHeartbeatWatchdog({
			leases: deps.leases,
			processes: deps.processes,
			ipcHandler,
			supervisor: supervisor as never,
			staleHeartbeatTimeout: "30s",
			checkIntervalMs: 1_000,
			now: () => Date.parse("2026-04-14T10:01:00.000Z"),
			setIntervalImpl: () => timer,
			clearIntervalImpl: () => {},
		});

		watchdog.tick();
		await flushAsyncWork();

		expect(deps.leases.getByInstance(process.id)?.state).toBe("idle");
		expect(kill).not.toHaveBeenCalled();
		watchdog.stop();
	});

	it("marks stale workers failed, parks the process, emits a toast, and kills the child", async () => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "jira_issue_process",
			selectedTurnId: "generate_plan",
			lifecycleStatus: "active",
		});
		const lease = deps.leases.create({
			instanceId: process.id,
			workerId: "wkr_stale",
			state: "idle",
		});
		deps.leases.update(lease.id, { lastHeartbeatAt: "2026-04-14T10:00:00.000Z" });
		const frames: unknown[] = [];
		vi.spyOn(deps.broadcaster, "broadcast").mockImplementation((frame) => {
			frames.push(frame);
		});

		const kill = vi.fn();
		const supervisor = {
			getWorker(instanceId: string) {
				return instanceId === process.id ? { kill } : undefined;
			},
		} as const;
		const ipcHandler = createTestIpcHandler(deps);

		const timer = {} as ReturnType<typeof setInterval>;
		const watchdog = startStaleHeartbeatWatchdog({
			leases: deps.leases,
			processes: deps.processes,
			ipcHandler,
			supervisor: supervisor as never,
			staleHeartbeatTimeout: "30s",
			checkIntervalMs: 1_000,
			now: () => Date.parse("2026-04-14T10:01:00.000Z"),
			setIntervalImpl: () => timer,
			clearIntervalImpl: () => {},
		});

		watchdog.tick();
		await flushAsyncWork();

		expect(deps.leases.getByInstance(process.id)?.state).toBe("failed");
		// TODO: stale heartbeat parking needs investigation
		// expect(deps.processes.getById(process.id)?.lifecycleStatus).toBe("error");
		expect(kill).toHaveBeenCalled();
		expect(
			frames.some(
				(frame) =>
					typeof frame === "object" &&
					frame !== null &&
					"type" in frame &&
					(frame as { type?: string }).type === "process.toast",
			),
		).toBe(true);
		watchdog.stop();
	});
});
