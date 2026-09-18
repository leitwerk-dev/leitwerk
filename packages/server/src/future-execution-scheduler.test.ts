import { describe, expect, it, vi } from "vitest";
import { startFutureExecutionScheduler } from "./future-execution-scheduler.js";

describe("future execution scheduler clock adapter", () => {
	it("reconciles missed schedules and runs one startup tick at the captured times", async () => {
		const reconcileMissedScheduleOccurrences = vi.fn(async () => ({
			kind: "occurrences_advanced" as const,
			asOf: "2026-04-25T10:00:00.000Z",
		}));
		const runDueWork = vi.fn(async () => ({
			kind: "batch_completed" as const,
			asOf: "2026-04-25T10:00:01.000Z",
			items: [],
		}));
		const times = [new Date("2026-04-25T10:00:00.000Z"), new Date("2026-04-25T10:00:01.000Z")];
		const scheduler = startFutureExecutionScheduler(
			{ reconcileMissedScheduleOccurrences, runDueWork },
			{ pollIntervalMs: 60_000, now: () => times.shift() ?? times[0] ?? new Date(0) },
		);

		await scheduler.start();
		await scheduler.stop();

		expect(reconcileMissedScheduleOccurrences).toHaveBeenCalledWith("2026-04-25T10:00:00.000Z");
		expect(runDueWork).toHaveBeenCalledWith("2026-04-25T10:00:01.000Z");
	});

	it("does not overlap timer callbacks", async () => {
		vi.useFakeTimers();
		let release: (() => void) | undefined;
		const runDueWork = vi.fn(
			() =>
				new Promise<{
					kind: "batch_completed";
					asOf: string;
					items: [];
				}>((resolve) => {
					release = () => resolve({ kind: "batch_completed", asOf: "", items: [] });
				}),
		);
		const scheduler = startFutureExecutionScheduler(
			{
				reconcileMissedScheduleOccurrences: async (asOf) => ({
					kind: "occurrences_advanced",
					asOf,
				}),
				runDueWork,
			},
			{ pollIntervalMs: 10, now: () => new Date("2026-04-25T10:00:00.000Z") },
		);
		const starting = scheduler.start();
		await vi.advanceTimersByTimeAsync(100);
		expect(runDueWork).toHaveBeenCalledTimes(1);
		release?.();
		await starting;
		await scheduler.stop();
		vi.useRealTimers();
	});
	it("waits for scheduled work to settle when stopped", async () => {
		vi.useFakeTimers();
		const gate = Promise.withResolvers<void>();
		const runDueWork = vi.fn(async (asOf: string) => {
			if (runDueWork.mock.calls.length > 1) await gate.promise;
			return { kind: "batch_completed" as const, asOf, items: [] };
		});
		const scheduler = startFutureExecutionScheduler(
			{
				reconcileMissedScheduleOccurrences: async (asOf) => ({
					kind: "occurrences_advanced",
					asOf,
				}),
				runDueWork,
			},
			{ pollIntervalMs: 10 },
		);
		try {
			await scheduler.start();
			await vi.advanceTimersByTimeAsync(10);
			let stopped = false;
			const stopping = scheduler.stop().then(() => {
				stopped = true;
			});
			await vi.advanceTimersByTimeAsync(100);
			expect(stopped).toBe(false);
			expect(runDueWork).toHaveBeenCalledTimes(2);
			gate.resolve();
			await stopping;
			expect(stopped).toBe(true);
		} finally {
			gate.resolve();
			await scheduler.stop();
			vi.useRealTimers();
		}
	});
});
