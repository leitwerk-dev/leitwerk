import { describe, expect, it } from "vitest";
import {
	scheduledLaunchOccurrenceKey,
	watcherAdmissionKey,
	withWatcherHandoffDedupKey,
} from "./launch-idempotency.js";

describe("launch idempotency keys", () => {
	it("keeps watcher admission and process handoff keys equal but independently applied", () => {
		const key = watcherAdmissionKey(" source:event:1 ");
		const plan = withWatcherHandoffDedupKey({ processId: "demo" } as never, key);

		expect(key).toBe("source:event:1");
		expect(plan).toMatchObject({ handoffDedupKey: "source:event:1" });
	});

	it("identifies a scheduled occurrence without mutable row revision data", () => {
		expect(
			scheduledLaunchOccurrenceKey({
				futureExecutionId: "fut_1",
				nextRunAt: "2027-04-25T09:00:00.000Z",
			}),
		).toBe("scheduled:fut_1:2027-04-25T09:00:00.000Z");
	});

	it("rejects empty watcher keys", () => {
		expect(() => watcherAdmissionKey("  ")).toThrow("must not be empty");
	});
});
