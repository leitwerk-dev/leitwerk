import type { PhysicalWorkerStart, StartupInterval, StartupMilestone } from "@leitwerk-dev/domain";
import { describe, expect, it } from "vitest";
import {
	type BenchmarkSample,
	imageCohort,
	launchTimings,
	report,
	statistics,
} from "./benchmark.js";

function worker(
	milestones: StartupMilestone[] = [],
	intervals: Record<string, StartupInterval> = {},
): PhysicalWorkerStart {
	return {
		workerLeaseId: "lease",
		workerId: "worker",
		turnStartRecordId: "start",
		turnRecordId: "turn",
		state: "ready",
		intervals,
		observations: milestones.map((milestone) => ({
			workerLeaseId: "lease",
			milestone,
			observedAt: "2026-09-15T00:00:01.000Z",
			sourceAt: null,
			sourceKind: "server",
			objectUid: null,
			turnRecordId: "turn",
			notBefore: null,
			metadata: {},
		})),
	};
}
function sample(input: Partial<BenchmarkSample> = {}): BenchmarkSample {
	return {
		index: 0,
		warmup: false,
		idempotencyKey: "key",
		startedAt: "2026-09-15T00:00:00Z",
		outcome: "completed",
		...input,
	};
}

describe("startup benchmark reports", () => {
	it("computes median and nearest-rank p90 without treating missing or invalid values as zero", () => {
		expect(statistics([])).toEqual({ count: 0, median: null, p90: null, maximum: null });
		expect(statistics([10, 1, 2, 3, 4, 5, 6, 7, 8, 9, null, undefined, NaN, -1])).toEqual({
			count: 10,
			median: 5.5,
			p90: 9,
			maximum: 10,
		});
		expect(statistics([5])).toEqual({ count: 1, median: 5, p90: 5, maximum: 5 });
	});
	it("requires positive image-cache evidence and separates pulls", () => {
		expect(imageCohort(worker())).toBe("unknown");
		expect(imageCohort(worker(["image_pull_finished"]))).toBe("unknown");
		expect(imageCohort(worker(["image_cached"]))).toBe("cached");
		expect(imageCohort(worker(["image_cached", "image_pull_started"]))).toBe("unknown");
		expect(imageCohort(worker(["image_pull_started", "image_pull_finished"]))).toBe("pulled");
	});
	it("uses server receipt time and reports missing or reversed milestones", () => {
		const startup = { workerStarts: [worker(["first_text"])] };
		expect(
			launchTimings({ createdAt: "2026-09-15T00:00:00Z" }, startup).launchToFirstText.durationMs,
		).toBe(1000);
		expect(launchTimings(undefined, startup).launchToFirstText.status).toBe("missing");
		expect(
			launchTimings({ createdAt: "2026-09-15T00:00:02Z" }, startup).launchToFirstText.status,
		).toBe("invalid_order");
	});
	it("includes failed launches in coverage, excludes warmups, and keeps replacements out of initial timings", () => {
		const interval = (durationMs: number | null): StartupInterval => ({
			start: null,
			end: null,
			durationMs,
			status: durationMs === null ? "missing" : "available",
			clock: "server",
		});
		const samples = [
			sample({
				warmup: true,
				startup: { workerStarts: [worker(["image_cached"], { total: interval(9999) })] },
			}),
			sample({
				startup: {
					workerStarts: [
						worker(["image_cached"], { total: interval(10) }),
						worker([], { total: interval(5000), replacementOnly: interval(5000) }),
					],
				},
			}),
			sample({ outcome: "timeout", launchTimings: { launchToFirstText: interval(null) } }),
		];
		const text = report(samples, 3);
		expect(text).toContain("Measured launches: 2 / 3; warm-ups: 1; failures/timeouts: 1");
		expect(text).toContain("| all | total | 1 / 2 | 10 | 10 | 10 |");
		expect(text).toContain("| all | launchToFirstText | 0 / 2 | unavailable |");
		expect(text).toContain("Launches with replacements: 1");
		expect(text).not.toContain("replacementOnly");
	});
});
