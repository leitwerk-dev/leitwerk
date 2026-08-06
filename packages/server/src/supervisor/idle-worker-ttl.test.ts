import type { ProcessInput, ProcessInstance, WorkerLease } from "@leitwerk-dev/domain";
import { describe, expect, it } from "vitest";
import { decideIdleWorkerStop } from "./idle-worker-ttl.js";

const lease: Pick<WorkerLease, "workerId" | "state"> = { workerId: "wkr_1", state: "idle" };
const process: Pick<ProcessInstance, "selectedTurnId" | "lifecycleStatus"> = {
	selectedTurnId: "review",
	lifecycleStatus: "waiting",
};

function input(overrides: Partial<Parameters<typeof decideIdleWorkerStop>[0]> = {}) {
	return {
		idleTtlMs: 1_000,
		hasWorkerHandle: true,
		lease,
		workerId: "wkr_1",
		process,
		selectedTurn: { turnType: "human" as const },
		unconsumedInputs: [],
		...overrides,
	};
}

function unconsumedInput(): Pick<ProcessInput, "consumedAt"> {
	return { consumedAt: null };
}

describe("decideIdleWorkerStop", () => {
	it("allows an idle worker to stop when no process work requires it", () => {
		expect(decideIdleWorkerStop(input())).toEqual({ shouldStop: true });
	});

	it("does not stop when idle deletion is disabled", () => {
		expect(decideIdleWorkerStop(input({ idleTtlMs: 0 }))).toEqual({
			shouldStop: false,
			reason: "disabled",
		});
	});

	it("does not stop a non-idle or stale worker lease", () => {
		expect(decideIdleWorkerStop(input({ lease: { workerId: "wkr_1", state: "busy" } }))).toEqual({
			shouldStop: false,
			reason: "lease_not_idle",
		});
		expect(decideIdleWorkerStop(input({ lease: { workerId: "wkr_old", state: "idle" } }))).toEqual({
			shouldStop: false,
			reason: "lease_not_idle",
		});
	});

	it("does not stop when queued input still needs delivery", () => {
		expect(decideIdleWorkerStop(input({ unconsumedInputs: [unconsumedInput()] }))).toEqual({
			shouldStop: false,
			reason: "unconsumed_inputs",
		});
	});

	it("does not stop when the selected active turn is worker-owned", () => {
		expect(
			decideIdleWorkerStop(
				input({
					process: { selectedTurnId: "implement", lifecycleStatus: "active" },
					selectedTurn: { turnType: "llm" },
				}),
			),
		).toEqual({ shouldStop: false, reason: "selected_turn_requires_worker" });
	});

	it("allows stop for terminal or waiting states even when a selected turn remains", () => {
		expect(
			decideIdleWorkerStop(
				input({
					process: { selectedTurnId: "done", lifecycleStatus: "completed" },
					selectedTurn: { turnType: "automatic" },
				}),
			),
		).toEqual({ shouldStop: true });
	});
});
