import { describe, expect, it, vi } from "vitest";
import type { ProcessEngine } from "../process-engine/types.js";
import { createWorkerTurnIpcRecorder } from "./worker-turn-ipc-recorder.js";

const outcome = {
	turnRecordId: "trn_1",
	turnId: "plan",
	turnType: "llm" as const,
	outcome: "plan",
	params: {},
	pathType: "primary" as const,
	resultPiEntryId: "assistant_1",
	turnResultMarkdown: "# Plan",
};

function createHarness(recordTurnOutcome: ProcessEngine["recordTurnOutcome"]) {
	let status: "running" | "failed" | "succeeded" = "running";
	const onTurnTerminalRecorded = vi.fn();
	const onTurnTerminalRecordingFailed = vi.fn();
	const recordWorkerFailure = vi.fn(async () => {
		status = "failed";
		return { ok: true as const, data: undefined };
	});
	const recorder = createWorkerTurnIpcRecorder(
		{
			processes: {} as never,
			turnRecords: {
				getById: () => ({ status }),
			} as never,
			commands: { recordTurnOutcome, recordWorkerFailure } as never,
			eventIngestor: {
				getLiveTurnRecordId: () => outcome.turnRecordId,
				clearLiveTurnState: vi.fn(),
			} as never,
		},
		{ onTurnTerminalRecorded, onTurnTerminalRecordingFailed },
	);
	return {
		recorder,
		recordWorkerFailure,
		onTurnTerminalRecorded,
		onTurnTerminalRecordingFailed,
	};
}

async function flushAsyncWork(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
	await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("worker turn IPC recording", () => {
	it("parks and acknowledges when outcome recording is rejected", async () => {
		const harness = createHarness(async () => ({
			ok: false as const,
			code: "invalid_process_state",
			message: "invalid plan outcome",
		}));

		harness.recorder.recordTurnOutcome("agt_1", "wkr_1", outcome);
		await flushAsyncWork();

		expect(harness.onTurnTerminalRecordingFailed).toHaveBeenCalledWith(
			expect.objectContaining({
				instanceId: "agt_1",
				workerId: "wkr_1",
				turnRecordId: "trn_1",
				terminalType: "outcome",
				code: "invalid_process_state",
			}),
		);
		expect(harness.recordWorkerFailure).toHaveBeenCalledWith(
			"agt_1",
			expect.objectContaining({ errorClass: "infrastructure" }),
		);
		expect(harness.onTurnTerminalRecorded).toHaveBeenCalledWith("agt_1", "wkr_1", "trn_1");
	});

	it("parks and acknowledges when outcome recording throws", async () => {
		const harness = createHarness(async () => {
			throw new Error("database unavailable");
		});

		harness.recorder.recordTurnOutcome("agt_1", "wkr_1", outcome);
		await flushAsyncWork();

		expect(harness.onTurnTerminalRecordingFailed).toHaveBeenCalledWith(
			expect.objectContaining({
				code: "turn_terminal_recording_threw",
				message: "database unavailable",
			}),
		);
		expect(harness.recordWorkerFailure).toHaveBeenCalledOnce();
		expect(harness.onTurnTerminalRecorded).toHaveBeenCalledOnce();
	});
});
