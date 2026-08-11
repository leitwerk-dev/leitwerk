import { describe, expect, it } from "vitest";
import { createTestDeps } from "../../test-helpers/unit-deps.js";
import { buildParkProcessWrites } from "./build-process-park-writes.js";

function createProcess(
	overrides: Parameters<ReturnType<typeof createTestDeps>["processes"]["create"]>[0],
) {
	return createTestDeps().processes.create({
		processId: "ticket_issue_process",
		selectedTurnId: "implement",
		lifecycleStatus: "active",
		...overrides,
	});
}

describe("buildParkProcessWrites", () => {
	it("parks the lifecycle without changing selectedTurnId", () => {
		const process = createProcess({
			selectedTurnId: "implement",
			lifecycleStatus: "active",
		});

		const planned = buildParkProcessWrites(process, {
			instanceId: process.id,
			selectedTurnId: "implement",
			reason: "Worker lost session state",
			errorClass: "pi_crash",
		});

		expect("ok" in planned).toBe(false);
		if ("ok" in planned) return;
		expect(planned.processPatch).toMatchObject({ lifecycleStatus: "error" });
		expect(planned.workerIntent).toEqual({
			kind: "stop_with_reason",
			reason: "lifecycle_parked:implement",
		});
		expect(planned.events).toEqual([
			{
				instanceId: process.id,
				eventType: "lifecycle_parked",
				data: {
					selectedTurnId: "implement",
					reason: "Worker lost session state",
					errorClass: "pi_crash",
				},
			},
		]);
	});

	it("can park a non-active lifecycle when explicitly allowed", () => {
		const process = createProcess({
			selectedTurnId: "plan_review",
			lifecycleStatus: "waiting",
		});

		const planned = buildParkProcessWrites(
			process,
			{
				instanceId: process.id,
				selectedTurnId: "plan_review",
				reason: "Worker failed while waiting for review input",
				errorClass: "infrastructure",
			},
			{ allowInactiveLifecycle: true },
		);

		expect("ok" in planned).toBe(false);
		if ("ok" in planned) return;
		expect(planned.processPatch).toMatchObject({ lifecycleStatus: "error" });
		expect(planned.events).toEqual([
			{
				instanceId: process.id,
				eventType: "lifecycle_parked",
				data: {
					selectedTurnId: "plan_review",
					reason: "Worker failed while waiting for review input",
					errorClass: "infrastructure",
				},
			},
		]);
	});

	it("rejects parking requests from a stale turn", () => {
		const process = createProcess({
			selectedTurnId: "address_review",
			lifecycleStatus: "active",
		});

		const planned = buildParkProcessWrites(process, {
			instanceId: process.id,
			selectedTurnId: "implement",
		});

		expect("ok" in planned).toBe(true);
		if (!("ok" in planned)) return;
		expect(planned.code).toBe("stale_turn");
	});
});
