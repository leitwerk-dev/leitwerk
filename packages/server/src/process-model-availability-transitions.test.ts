import { describe, expect, it, vi } from "vitest";
import { applyProcessModelAvailabilityTransitions } from "./process-model-availability-transitions.js";

function snapshot() {
	return {
		revision: 4,
		capturedAt: "2026-01-01T00:00:00.000Z",
		profiles: [],
		availabilityTransitions: [
			{ profileId: "degraded", from: "available" as const, to: "unavailable" as const },
			{ profileId: "stale", from: "unavailable" as const, to: "stale" as const },
			{ profileId: "restored", from: "stale" as const, to: "available" as const },
		],
	};
}

describe("process model availability transition wiring", () => {
	it("reconciles every changed profile but recovers processes only for restorations", async () => {
		const reconcileFutureExecutions = vi.fn(async () => {});
		const recoverProcesses = vi.fn(async () => {});

		await applyProcessModelAvailabilityTransitions({
			snapshot: snapshot(),
			reconcileFutureExecutions,
			recoverProcesses,
		});

		expect([...reconcileFutureExecutions.mock.calls[0][0]].sort()).toEqual([
			"degraded",
			"restored",
			"stale",
		]);
		expect([...recoverProcesses.mock.calls[0][0]]).toEqual(["restored"]);
	});
});
