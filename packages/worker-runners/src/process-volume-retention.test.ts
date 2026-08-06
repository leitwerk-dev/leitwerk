import type { ProcessInstance } from "@leitwerk-dev/domain";
import { describe, expect, it } from "vitest";
import {
	cleanupRetainedProcessVolumes,
	planProcessVolumeRetentionCleanup,
} from "./process-volume-retention.js";
import type { ProcessVolume, VolumeRef } from "./types.js";

function process(overrides: Partial<ProcessInstance>): ProcessInstance {
	return {
		id: "proc",
		processId: "test_process",
		selectedTurnId: null,
		lifecycleStatus: "active",
		planRevision: 0,
		title: null,
		externalId: null,
		externalUrl: null,
		metadata: null,
		paramsJson: null,
		stateJson: null,
		createdAt: "2026-06-01T00:00:00.000Z",
		updatedAt: "2026-06-01T00:00:00.000Z",
		closedAt: null,
		...overrides,
	};
}

describe("planProcessVolumeRetentionCleanup", () => {
	it("selects completed and aborted process volumes whose closedAt age exceeds their retention", () => {
		const now = new Date("2026-06-23T12:00:00.000Z");

		expect(
			planProcessVolumeRetentionCleanup({
				now,
				policy: { completedProcessRetention: "7d", errorProcessRetention: "30d" },
				processes: [
					process({
						id: "completed-old",
						lifecycleStatus: "completed",
						closedAt: "2026-06-16T11:59:59.000Z",
					}),
					process({
						id: "completed-fresh",
						lifecycleStatus: "completed",
						closedAt: "2026-06-17T12:00:00.000Z",
					}),
					process({
						id: "aborted-old",
						lifecycleStatus: "aborted",
						closedAt: "2026-05-01T00:00:00.000Z",
					}),
					process({ id: "active", lifecycleStatus: "active" }),
				],
			}),
		).toEqual(["completed-old", "aborted-old"]);
	});

	it("ignores invalid closedAt values and already released process volumes", () => {
		expect(
			planProcessVolumeRetentionCleanup({
				now: new Date("2026-06-23T12:00:00.000Z"),
				policy: { completedProcessRetention: "1h", errorProcessRetention: "1h" },
				alreadyReleased: new Set(["released"]),
				processes: [
					process({ id: "invalid", lifecycleStatus: "completed", closedAt: "not-a-date" }),
					process({
						id: "released",
						lifecycleStatus: "completed",
						closedAt: "2026-01-01T00:00:00.000Z",
					}),
				],
			}),
		).toEqual([]);
	});
});

describe("cleanupRetainedProcessVolumes", () => {
	it("releases only planned process volumes", async () => {
		const released: string[] = [];
		const volume: ProcessVolume = {
			async ensure(instanceId: string): Promise<VolumeRef> {
				return { instanceId, id: instanceId, mountPath: "/state" };
			},
			async release(instanceId: string): Promise<void> {
				released.push(instanceId);
			},
			async deleteProcessResources(): Promise<void> {
				throw new Error("retention must not delete all process resources");
			},
		};

		await expect(
			cleanupRetainedProcessVolumes({
				volume,
				now: new Date("2026-06-23T12:00:00.000Z"),
				policy: { completedProcessRetention: "1d", errorProcessRetention: "1d" },
				processes: [
					process({
						id: "old",
						lifecycleStatus: "completed",
						closedAt: "2026-06-01T00:00:00.000Z",
					}),
					process({
						id: "fresh",
						lifecycleStatus: "completed",
						closedAt: "2026-06-23T11:00:00.000Z",
					}),
				],
			}),
		).resolves.toEqual(["old"]);
		expect(released).toEqual(["old"]);
	});
});
