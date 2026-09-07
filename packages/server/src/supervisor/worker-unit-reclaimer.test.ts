import type { WorkerExitInfo, WorkerUnit } from "@leitwerk-dev/worker-runners/types";
import { describe, expect, it, vi } from "vitest";
import { createWorkerUnitReclaimer } from "./worker-unit-reclaimer.js";

function workerUnit(
	onExit: (listener: (info: WorkerExitInfo) => void) => void,
	replacementHandoff?: WorkerUnit["replacementHandoff"],
): WorkerUnit {
	return {
		instanceId: "proc-1",
		workerId: "wkr-1",
		unitId: "pod-1",
		namespace: "process-1",
		...(replacementHandoff ? { replacementHandoff } : {}),
		onExit,
	};
}

describe("createWorkerUnitReclaimer", () => {
	it("reclaims the runtime unit after natural worker exit", async () => {
		let exitListener: ((info: WorkerExitInfo) => void) | undefined;
		const stop = vi.fn(async () => {});
		const observedExit = vi.fn();
		const reclaimer = createWorkerUnitReclaimer({ runner: { stop } });
		const unit = workerUnit((listener) => {
			exitListener = listener;
		});
		reclaimer.observeExit(unit, observedExit);

		exitListener?.({ exitCode: 0, signal: null, reason: "Completed" });
		await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));

		expect(observedExit).toHaveBeenCalled();
		expect(stop).toHaveBeenCalledWith(unit, { graceMs: 0 });
		expect(reclaimer.staleResourceBacklogCount()).toBe(0);
	});

	it("delays replacement notification until strict handoff cleanup succeeds", async () => {
		let exitListener: ((info: WorkerExitInfo) => void) | undefined;
		const stop = vi
			.fn<(ref: WorkerUnit, options: { graceMs: number }) => Promise<void>>()
			.mockRejectedValueOnce(new Error("container removal failed"))
			.mockResolvedValue(undefined);
		const observedExit = vi.fn();
		const reclaimer = createWorkerUnitReclaimer({
			runner: { stop },
			retry: { initialDelayMs: 1, maxDelayMs: 1 },
		});
		const unit = workerUnit((listener) => {
			exitListener = listener;
		}, "stop-before-replacement");
		reclaimer.observeExit(unit, observedExit);

		exitListener?.({ exitCode: 1, signal: null, reason: "Failed" });
		await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
		expect(observedExit).not.toHaveBeenCalled();

		await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(2));
		expect(observedExit).toHaveBeenCalledWith({
			exitCode: 1,
			signal: null,
			reason: "Failed",
		});
	});

	it("queues failed cleanup and retries it in the background", async () => {
		const stop = vi
			.fn<(ref: WorkerUnit, options: { graceMs: number }) => Promise<void>>()
			.mockRejectedValueOnce(new Error("runtime unavailable"))
			.mockResolvedValue(undefined);
		const warn = vi.fn();
		const reclaimer = createWorkerUnitReclaimer({
			runner: { stop },
			logger: { warn },
			retry: { initialDelayMs: 1, maxDelayMs: 1 },
		});
		const unit = workerUnit(() => {});

		await reclaimer.reclaim(unit, "startup_stale");
		expect(reclaimer.staleResourceBacklogCount()).toBe(1);
		expect(() => reclaimer.assertProcessReclaimed("proc-1")).toThrow("still being removed");
		expect(() => reclaimer.assertProcessReclaimed("proc-2")).not.toThrow();
		await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(2));

		expect(reclaimer.staleResourceBacklogCount()).toBe(0);
		expect(() => reclaimer.assertProcessReclaimed("proc-1")).not.toThrow();
		expect(warn).toHaveBeenCalledWith(
			expect.objectContaining({ staleResourceBacklogCount: 1 }),
			"Terminal worker unit cleanup failed; queued for retry",
		);
	});
});
