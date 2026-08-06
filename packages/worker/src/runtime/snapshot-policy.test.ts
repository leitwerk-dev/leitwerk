import { describe, expect, it } from "vitest";
import { resolveWorkerSnapshotPolicy } from "./snapshot-policy.js";

describe("worker snapshot policy", () => {
	it("skips automatic and unopened cleanup snapshots", () => {
		expect(resolveWorkerSnapshotPolicy("before_turn_outcome", "automatic", false)).toEqual({
			upload: false,
		});
		expect(resolveWorkerSnapshotPolicy("before_cleanup_completed", "llm", false)).toEqual({
			upload: false,
		});
	});

	it("requires correlated LLM terminal snapshots", () => {
		expect(resolveWorkerSnapshotPolicy("before_turn_failed", "llm", true)).toEqual({
			upload: true,
			required: true,
			turnCorrelated: true,
		});
	});
});
