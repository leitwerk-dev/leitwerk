import type { ServerToWorkerMessage } from "@leitwerk-dev/worker-protocol";
import { describe, expect, it } from "vitest";
import {
	createInitialWorkerRuntimeState,
	decideWorkerInputEffect,
	deriveReportedWorkerState,
	reduceWorkerRuntime,
	type WorkerRuntimeOutput,
	type WorkerRuntimeStateMachine,
} from "./lifecycle-reducer.js";

const ordinary = {
	inputId: "input_1",
	sequence: 1,
	source: "operator",
	kind: "message",
	target: null,
	bodyMarkdown: "first",
};
const targeted = {
	...ordinary,
	inputId: "input_2",
	sequence: 2,
	target: { kind: "semantic_ref" as const, ref: "plan" as const },
};

function llmSession(lifecycleStatus = "running") {
	return {
		kind: "llm",
		treeFile: "/tmp/tree.jsonl",
		piAvailable: true,
		selectedTurnId: "turn_definition",
		processSnapshot: { lifecycleStatus },
	} as never;
}

function activeLlmState(): WorkerRuntimeStateMachine {
	return {
		...createInitialWorkerRuntimeState(),
		phase: {
			kind: "active",
			startRecordId: "start_1",
			turnRecordId: "record_1",
			turnStatus: "executing",
		},
		session: llmSession(),
	};
}

function drainingLlmState(piAvailable = true): WorkerRuntimeStateMachine {
	return {
		...createInitialWorkerRuntimeState(),
		phase: { kind: "draining", reason: "stop", exitAfterCleanup: true, operation: null },
		session: { ...llmSession(), piAvailable } as never,
	};
}

function readySnapshotState(): WorkerRuntimeStateMachine {
	return {
		...createInitialWorkerRuntimeState(),
		phase: {
			kind: "readying",
			startRecordId: "start_1",
			proposedTurnRecordId: "record_1",
			acceptedId: null,
		},
		session: llmSession(),
		work: {
			deliveryHeadSequence: null,
			publication: {
				kind: "ready_snapshot",
				snapshot: {
					point: "after_worker_ready",
					turnRecordId: null,
					required: false,
				},
			},
		},
	};
}

function outcomeResult() {
	return {
		kind: "outcome" as const,
		turnId: "turn_definition",
		outcome: "done",
		params: {},
		meta: {
			turnRecordId: "record_1",
			turnType: "llm" as const,
			pathType: "primary" as const,
		},
		appliedTargetedInputs: [],
	};
}

function outputsOfKind<T extends WorkerRuntimeOutput["kind"]>(
	outputs: readonly WorkerRuntimeOutput[],
	kind: T,
): Extract<WorkerRuntimeOutput, { kind: T }>[] {
	return outputs.filter(
		(output): output is Extract<WorkerRuntimeOutput, { kind: T }> => output.kind === kind,
	);
}

function protocolTypes(outputs: readonly WorkerRuntimeOutput[]): string[] {
	return outputs.filter((output) => output.kind === "protocol").map((output) => output.type);
}

describe("worker runtime reducer", () => {
	it("keeps ordinary batching behind targeted FIFO barriers", () => {
		expect(
			decideWorkerInputEffect({
				items: [ordinary, targeted, { ...ordinary, inputId: "input_3", sequence: 3 }],
				sessionTainted: false,
				piAvailable: true,
				mayStartTurn: true,
			}),
		).toEqual({ kind: "deliver", inputs: [ordinary] });
		expect(
			decideWorkerInputEffect({
				items: [targeted],
				sessionTainted: false,
				piAvailable: true,
				mayStartTurn: true,
			}),
		).toEqual({ kind: "start_turn", inputs: [targeted] });
	});

	it("blocks all queued input while tainted", () => {
		expect(
			decideWorkerInputEffect({
				items: [ordinary],
				sessionTainted: true,
				piAvailable: true,
				mayStartTurn: true,
			}),
		).toEqual({ kind: "blocked", reason: "session_tainted" });
	});

	it("starts exactly one bootstrap command and ignores duplicate starts", () => {
		const started = reduceWorkerRuntime(createInitialWorkerRuntimeState(), {
			kind: "runtime_started",
		});
		const message = {
			type: "worker.start",
			payload: { turnStart: { id: "start_1", proposedTurnRecordId: "turn_1" } },
		} as ServerToWorkerMessage;
		const first = reduceWorkerRuntime(started.state, { kind: "server_message", message });
		const duplicate = reduceWorkerRuntime(first.state, { kind: "server_message", message });
		expect(first.outputs.filter((output) => output.kind === "bootstrap")).toHaveLength(1);
		expect(duplicate.outputs).toEqual([]);
	});

	it("does not acknowledge a turn when pre-turn bootstrap fails", () => {
		const started = reduceWorkerRuntime(createInitialWorkerRuntimeState(), {
			kind: "runtime_started",
		});
		const message = {
			type: "worker.start",
			payload: {
				processSnapshot: {
					selectedTurnId: "turn_definition",
					lifecycleStatus: "running",
				},
				turnStart: { id: "start_tools", proposedTurnRecordId: "record_tools" },
				bootstrap: { kind: "automatic" },
				treePaths: { primaryTreeFile: "/tmp/tree.jsonl" },
			},
		} as ServerToWorkerMessage;
		const bootstrapping = reduceWorkerRuntime(started.state, {
			kind: "server_message",
			message,
		});
		const bootstrap = outputsOfKind(bootstrapping.outputs, "bootstrap")[0];
		if (!bootstrap) throw new Error("Expected bootstrap output");

		const failed = reduceWorkerRuntime(bootstrapping.state, {
			kind: "bootstrap_failed",
			startRecordId: "start_tools",
			payload: bootstrap.payload,
			error: new Error("mise install failed"),
		});

		expect(protocolTypes(failed.outputs)).not.toContain("worker.turn_started");
		expect(failed.state.phase.kind).not.toBe("active");
	});

	it("ignores stale command completions by domain identity", () => {
		const state = createInitialWorkerRuntimeState();
		const reduced = reduceWorkerRuntime(state, {
			kind: "snapshot_succeeded",
			point: "before_turn_outcome",
			turnRecordId: "stale_turn",
		});
		expect(reduced).toEqual({ state, outputs: [] });
	});

	it.each([
		"snapshot_succeeded",
		"snapshot_failed",
	] as const)("continues readying after %s", (kind) => {
		const state = readySnapshotState();
		const reduced = reduceWorkerRuntime(state, {
			kind,
			point: "after_worker_ready",
			turnRecordId: null,
			...(kind === "snapshot_failed" ? { error: new Error("ignored") } : {}),
		});
		expect(reduced.state.work.publication).toEqual({ kind: "none" });
		expect(reduced.state.phase.kind).toBe("waiting_for_acceptance");
		expect(protocolTypes(reduced.outputs)).toContain("worker.turn_started");
	});

	it.each([
		"snapshot_succeeded",
		"snapshot_failed",
	] as const)("drains after pending ready %s", (kind) => {
		const ready = readySnapshotState();
		const stopped = reduceWorkerRuntime(ready, {
			kind: "stop_requested",
			reason: "operator",
			exitAfterCleanup: true,
		});
		const completed = reduceWorkerRuntime(stopped.state, {
			kind,
			error: new Error("best effort failed"),
			point: "after_worker_ready",
			turnRecordId: null,
		});
		expect(completed.state.phase.kind).toBe("cleaning");
		expect(protocolTypes(completed.outputs)).toContain("worker.cleanup_started");
		expect(protocolTypes(completed.outputs)).not.toContain("worker.turn_started");
	});

	it("publishes an LLM terminal fact only after its mandatory snapshot", () => {
		const completed = reduceWorkerRuntime(activeLlmState(), {
			kind: "turn_completed",
			turnRecordId: "record_1",
			result: outcomeResult(),
		});

		expect(completed.state.phase).toMatchObject({ kind: "active", turnStatus: "completed" });
		expect(completed.state.work.publication).toMatchObject({
			kind: "terminal_snapshot",
			snapshot: {
				point: "before_turn_outcome",
				turnRecordId: "record_1",
				required: true,
			},
		});
		expect(deriveReportedWorkerState(completed.state)).toBe("busy");
		expect(outputsOfKind(completed.outputs, "upload_snapshot")).toHaveLength(1);
		expect(protocolTypes(completed.outputs)).not.toContain("worker.turn_outcome");

		for (const kind of ["snapshot_succeeded", "snapshot_failed"] as const) {
			for (const correlation of [
				{ point: "before_turn_outcome", turnRecordId: "other_record" },
				{ point: "before_turn_failed", turnRecordId: "record_1" },
			] as const) {
				const mismatch = reduceWorkerRuntime(completed.state, {
					kind,
					...correlation,
					error: new Error("stale upload failed"),
				});
				expect(mismatch).toEqual({ state: completed.state, outputs: [] });
			}
		}

		const published = reduceWorkerRuntime(completed.state, {
			kind: "snapshot_succeeded",
			point: "before_turn_outcome",
			turnRecordId: "record_1",
		});
		expect(published.state.work.publication).toMatchObject({ kind: "terminal_pending_ack" });
		expect(deriveReportedWorkerState(published.state)).toBe("busy");
		expect(protocolTypes(published.outputs)).toContain("worker.turn_outcome");
		expect(outputsOfKind(published.outputs, "arm_timer")).toContainEqual(
			expect.objectContaining({ name: "terminal_ack", correlation: "record_1" }),
		);
		expect(outputsOfKind(published.outputs, "upload_snapshot")).toHaveLength(0);

		const retried = reduceWorkerRuntime(published.state, {
			kind: "timer_fired",
			name: "terminal_ack",
			correlation: "record_1",
		});
		expect(protocolTypes(retried.outputs)).toContain("worker.turn_outcome");

		const reconnected = reduceWorkerRuntime(retried.state, { kind: "transport_connected" });
		expect(protocolTypes(reconnected.outputs)).toContain("worker.turn_outcome");

		const acknowledged = reduceWorkerRuntime(reconnected.state, {
			kind: "server_message",
			message: {
				type: "worker.turn_terminal_recorded",
				payload: { turnRecordId: "record_1" },
			} as ServerToWorkerMessage,
		});
		expect(acknowledged.state.work.publication).toEqual({ kind: "none" });
		expect(deriveReportedWorkerState(acknowledged.state)).toBe("idle");
		expect(protocolTypes(acknowledged.outputs)).toContain("worker.state");
	});

	it("replaces a terminal fact when its mandatory snapshot fails", () => {
		const completed = reduceWorkerRuntime(activeLlmState(), {
			kind: "turn_completed",
			turnRecordId: "record_1",
			result: outcomeResult(),
		});
		const failed = reduceWorkerRuntime(completed.state, {
			kind: "snapshot_failed",
			point: "before_turn_outcome",
			turnRecordId: "record_1",
			error: new Error("upload failed"),
		});

		expect(failed.state.work.publication).toEqual({ kind: "none" });
		expect(protocolTypes(failed.outputs)).toContain("worker.turn_failed");
		expect(protocolTypes(failed.outputs)).toContain("worker.lifecycle_parked");
		expect(protocolTypes(failed.outputs)).not.toContain("worker.turn_outcome");
	});

	it("keeps draining precedence while a terminal publication finishes", () => {
		const completed = reduceWorkerRuntime(activeLlmState(), {
			kind: "turn_completed",
			turnRecordId: "record_1",
			result: outcomeResult(),
		});
		const stopped = reduceWorkerRuntime(completed.state, {
			kind: "stop_requested",
			reason: "operator",
			exitAfterCleanup: true,
		});
		expect(stopped.state.phase.kind).toBe("draining");
		expect(deriveReportedWorkerState(stopped.state)).toBe("draining");

		const published = reduceWorkerRuntime(stopped.state, {
			kind: "snapshot_succeeded",
			point: "before_turn_outcome",
			turnRecordId: "record_1",
		});
		expect(published.state.phase.kind).toBe("draining");
		expect(published.state.work.publication.kind).toBe("terminal_pending_ack");
		expect(protocolTypes(published.outputs)).toContain("worker.turn_outcome");
		expect(protocolTypes(published.outputs)).not.toContain("worker.cleanup_started");

		const acknowledged = reduceWorkerRuntime(published.state, {
			kind: "server_message",
			message: {
				type: "worker.turn_terminal_recorded",
				payload: { turnRecordId: "record_1" },
			} as ServerToWorkerMessage,
		});
		expect(acknowledged.state.phase).toMatchObject({ kind: "cleaning", stage: "publication" });
		expect(acknowledged.state.work.publication.kind).toBe("cleanup_snapshot");
		expect(protocolTypes(acknowledged.outputs)).toContain("worker.cleanup_started");
	});

	it.each([
		"snapshot_succeeded",
		"snapshot_failed",
	] as const)("continues cleanup after upload failure and fatal %s", (kind) => {
		const cleanupStarted = reduceWorkerRuntime(drainingLlmState(), {
			kind: "operator_abort_observed",
		});
		expect(cleanupStarted.state.work.publication.kind).toBe("cleanup_snapshot");

		const cleanupSnapshotFailed = reduceWorkerRuntime(cleanupStarted.state, {
			kind: "snapshot_failed",
			point: "before_cleanup_completed",
			turnRecordId: null,
			error: new Error("final upload failed"),
		});
		expect(cleanupSnapshotFailed.state.work.publication.kind).toBe("fatal_snapshot");
		expect(outputsOfKind(cleanupSnapshotFailed.outputs, "upload_snapshot")).toHaveLength(1);

		const fatalSnapshotSettled = reduceWorkerRuntime(cleanupSnapshotFailed.state, {
			kind,
			point: "before_worker_failed",
			turnRecordId: null,
			error: new Error("best effort failed"),
		});
		expect(fatalSnapshotSettled.state.phase).toMatchObject({
			kind: "cleaning",
			stage: "resources",
		});
		expect(fatalSnapshotSettled.state.work.publication.kind).toBe("fatal_pending_cleanup");
		expect(outputsOfKind(fatalSnapshotSettled.outputs, "cleanup")).toHaveLength(1);

		const cleaned = reduceWorkerRuntime(fatalSnapshotSettled.state, {
			kind: "cleanup_succeeded",
		});
		expect(cleaned.state.phase.kind).toBe("exited");
		expect(cleaned.state.work.publication).toEqual({ kind: "none" });
		expect(protocolTypes(cleaned.outputs)).toContain("worker.failed");
		expect(outputsOfKind(cleaned.outputs, "close_transport")).toHaveLength(1);
		expect(outputsOfKind(cleaned.outputs, "exit")).toHaveLength(1);
	});

	it("replaces a deferred fatal when resource cleanup fails", () => {
		const cleanupStarted = reduceWorkerRuntime(drainingLlmState(), {
			kind: "operator_abort_observed",
		});
		const cleanupSnapshotFailed = reduceWorkerRuntime(cleanupStarted.state, {
			kind: "snapshot_failed",
			point: "before_cleanup_completed",
			turnRecordId: null,
			error: new Error("final upload failed"),
		});
		const fatalSnapshotFinished = reduceWorkerRuntime(cleanupSnapshotFailed.state, {
			kind: "snapshot_succeeded",
			point: "before_worker_failed",
			turnRecordId: null,
		});
		const cleanupFailed = reduceWorkerRuntime(fatalSnapshotFinished.state, {
			kind: "cleanup_failed",
			error: new Error("resource cleanup failed"),
		});

		expect(cleanupFailed.state.phase.kind).toBe("exited");
		expect(cleanupFailed.state.work.publication).toEqual({ kind: "none" });
		const failedFact = cleanupFailed.outputs.find(
			(output) => output.kind === "protocol" && output.type === "worker.failed",
		);
		expect(failedFact).toMatchObject({ payload: { message: "resource cleanup failed" } });
		expect(outputsOfKind(cleanupFailed.outputs, "upload_snapshot")).toHaveLength(0);
	});

	it("skips an unavailable cleanup snapshot", () => {
		const reduced = reduceWorkerRuntime(drainingLlmState(false), {
			kind: "operator_abort_observed",
		});
		expect(reduced.state.phase).toMatchObject({ kind: "cleaning", stage: "resources" });
		expect(reduced.state.work.publication).toEqual({ kind: "none" });
		expect(outputsOfKind(reduced.outputs, "upload_snapshot")).toHaveLength(0);
		expect(outputsOfKind(reduced.outputs, "cleanup")).toHaveLength(1);
	});

	it("runs resource cleanup after a successful cleanup snapshot", () => {
		const snapshot = reduceWorkerRuntime(drainingLlmState(), {
			kind: "operator_abort_observed",
		});
		const uploaded = reduceWorkerRuntime(snapshot.state, {
			kind: "snapshot_succeeded",
			point: "before_cleanup_completed",
			turnRecordId: null,
		});
		expect(uploaded.state.phase).toMatchObject({ kind: "cleaning", stage: "resources" });
		expect(uploaded.state.work.publication).toEqual({ kind: "none" });
		expect(outputsOfKind(uploaded.outputs, "cleanup")).toHaveLength(1);

		const cleaned = reduceWorkerRuntime(uploaded.state, { kind: "cleanup_succeeded" });
		expect(cleaned.state.phase.kind).toBe("exited");
		expect(protocolTypes(cleaned.outputs)).toContain("worker.cleanup_completed");
	});

	it("finishes a fatal failure after its best-effort snapshot", () => {
		const state = { ...activeLlmState(), session: llmSession("error") };
		const pending = reduceWorkerRuntime(state, {
			kind: "invariant_failed",
			error: new Error("fatal"),
		});
		const finished = reduceWorkerRuntime(pending.state, {
			kind: "snapshot_succeeded",
			point: "before_worker_failed",
			turnRecordId: null,
		});
		expect(finished.state.phase.kind).toBe("exited");
		expect(finished.state.work.publication).toEqual({ kind: "none" });
		expect(protocolTypes(finished.outputs)).toContain("worker.failed");
		expect(outputsOfKind(finished.outputs, "close_transport")).toHaveLength(1);
		expect(outputsOfKind(finished.outputs, "exit")).toHaveLength(1);
	});

	it("reports a fatal failure immediately when no snapshot source exists", () => {
		const state: WorkerRuntimeStateMachine = {
			...createInitialWorkerRuntimeState(),
			phase: { kind: "waiting_for_start" },
		};
		const failed = reduceWorkerRuntime(state, {
			kind: "invariant_failed",
			error: new Error("fatal without session"),
		});
		expect(failed.state.phase.kind).toBe("exited");
		expect(failed.state.work.publication).toEqual({ kind: "none" });
		expect(outputsOfKind(failed.outputs, "upload_snapshot")).toHaveLength(0);
		expect(protocolTypes(failed.outputs)).toContain("worker.failed");
	});

	it("uses the newer fatal when failure repeats during fatal publication", () => {
		const state = {
			...activeLlmState(),
			session: llmSession("error"),
		};
		const first = reduceWorkerRuntime(state, {
			kind: "invariant_failed",
			error: Object.assign(new Error("first"), { code: "first_failure" }),
		});
		expect(first.state.work.publication.kind).toBe("fatal_snapshot");

		const repeated = reduceWorkerRuntime(first.state, {
			kind: "invariant_failed",
			error: Object.assign(new Error("second"), { code: "second_failure" }),
		});
		expect(repeated.state.phase.kind).toBe("exited");
		expect(repeated.state.work.publication).toEqual({ kind: "none" });
		const failedFact = repeated.outputs.find(
			(output) => output.kind === "protocol" && output.type === "worker.failed",
		);
		expect(failedFact).toMatchObject({ payload: { message: "second" } });
		expect(outputsOfKind(repeated.outputs, "upload_snapshot")).toHaveLength(0);
	});

	it("clears pending publication when transport is lost", () => {
		const pending = reduceWorkerRuntime(activeLlmState(), {
			kind: "turn_completed",
			turnRecordId: "record_1",
			result: outcomeResult(),
		});
		const lost = reduceWorkerRuntime(pending.state, {
			kind: "transport_failed",
			error: new Error("disconnected"),
		});
		expect(lost.state.phase.kind).toBe("exited");
		expect(lost.state.work.publication).toEqual({ kind: "none" });
		expect(protocolTypes(lost.outputs)).not.toContain("worker.failed");
		expect(outputsOfKind(lost.outputs, "close_transport")).toHaveLength(1);
		expect(outputsOfKind(lost.outputs, "exit")).toHaveLength(1);
	});
});
