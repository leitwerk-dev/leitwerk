import { expect, it } from "vitest";
import { physicalWorkerStarts, startupInterval } from "./physical-worker-starts.js";

it("keeps missing evidence and clock inversions distinct from measured zero", () => {
	expect(startupInterval(null, "2026-09-11")).toMatchObject({
		status: "missing",
		durationMs: null,
	});
	expect(startupInterval("2026-09-12", "2026-09-11", "kubernetes")).toMatchObject({
		status: "invalid_order",
		durationMs: null,
		clock: "kubernetes",
	});
	expect(startupInterval("2026-09-11", "2026-09-11")).toMatchObject({
		status: "available",
		durationMs: 0,
	});
	expect(startupInterval("bad", "bad")).toMatchObject({
		status: "invalid_order",
		durationMs: null,
	});
	expect(
		physicalWorkerStarts({ leases: [], turnStarts: [], turnRecords: [], observations: [] }),
	).toEqual([]);
});
