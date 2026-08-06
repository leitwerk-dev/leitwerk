import type { WorkerState } from "@leitwerk-dev/domain";
import { describe, expect, it } from "vitest";
import type { WorkerLeaseObservation } from "./worker-lease-lifecycle.js";
import { transitionWorkerLeaseState } from "./worker-lease-lifecycle.js";

function applyObservation(
	state: WorkerState | null | undefined,
	observation: WorkerLeaseObservation,
): WorkerState {
	const result = transitionWorkerLeaseState(state, observation);
	expect(result.kind).toBe("applied");
	if (result.kind !== "applied") {
		throw new Error("expected applied worker lease observation");
	}
	return result.to;
}

describe("worker-lease-lifecycle", () => {
	describe("transitionWorkerLeaseState", () => {
		it("runs full happy path from absent through reclaimed", () => {
			let s: WorkerState = "absent";
			s = applyObservation(s, "spawn_requested");
			expect(s).toBe("spawning");
			s = applyObservation(s, "handshake_received");
			expect(s).toBe("bootstrapping");
			s = applyObservation(s, "bootstrap_completed");
			expect(s).toBe("idle");
			s = applyObservation(s, "busy_reported");
			expect(s).toBe("busy");
			s = applyObservation(s, "idle_reported");
			expect(s).toBe("idle");
			s = applyObservation(s, "stop_requested");
			expect(s).toBe("draining");
			s = applyObservation(s, "cleanup_completed");
			expect(s).toBe("cleanup");
			s = applyObservation(s, "process_exited");
			expect(s).toBe("exited");
			s = applyObservation(s, "reclaimed");
			expect(s).toBe("absent");
		});

		it("models bootstrap failure and forced exit", () => {
			let s: WorkerState = "bootstrapping";
			s = applyObservation(s, "failure_reported");
			expect(s).toBe("failed");
			s = applyObservation(s, "process_exited");
			expect(s).toBe("exited");
		});

		it("models stop during spawn and later forced exit", () => {
			let s: WorkerState = "spawning";
			s = applyObservation(s, "stop_requested");
			expect(s).toBe("draining");
			s = applyObservation(s, "process_exited");
			expect(s).toBe("exited");
		});

		it("treats duplicate and stale observations as noops", () => {
			expect(transitionWorkerLeaseState("idle", "bootstrap_completed")).toEqual(
				expect.objectContaining({ kind: "noop", from: "idle", to: "idle" }),
			);
			expect(transitionWorkerLeaseState("busy", "busy_reported")).toEqual(
				expect.objectContaining({ kind: "noop", from: "busy", to: "busy" }),
			);
			expect(transitionWorkerLeaseState("draining", "idle_reported")).toEqual(
				expect.objectContaining({ kind: "noop", from: "draining", to: "draining" }),
			);
			expect(transitionWorkerLeaseState("exited", "process_exited")).toEqual(
				expect.objectContaining({ kind: "noop", from: "exited", to: "exited" }),
			);
		});

		it("returns invalid for impossible observations", () => {
			const cases: Array<{ state: WorkerState; observation: WorkerLeaseObservation }> = [
				{ state: "absent", observation: "handshake_received" },
				{ state: "busy", observation: "reclaimed" },
				{ state: "bootstrapping", observation: "busy_reported" },
				{ state: "bootstrapping", observation: "idle_reported" },
				{ state: "spawning", observation: "idle_reported" },
				{ state: "cleanup", observation: "reclaimed" },
			];

			for (const { state, observation } of cases) {
				const result = transitionWorkerLeaseState(state, observation);
				expect(result.kind).toBe("invalid");
				if (result.kind !== "invalid") {
					throw new Error("expected invalid result");
				}
				expect(result.from).toBe(state);
				expect(result.observation).toBe(observation);
				expect(result.message).toContain(state);
				expect(result.message).toContain(observation);
			}
		});
	});
});
