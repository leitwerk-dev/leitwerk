import { createTestQuestion } from "@leitwerk-dev/test-support/fixtures";
import type { ServerToWorkerMessage } from "@leitwerk-dev/worker-protocol";
import { describe, expect, it, vi } from "vitest";
import { WorkerQuestionBridge } from "./question-bridge.js";

const questions = [createTestQuestion()];

function response(
	overrides: Partial<
		Extract<ServerToWorkerMessage, { type: "worker.question_response" }>["payload"]
	> = {},
): Extract<ServerToWorkerMessage, { type: "worker.question_response" }> {
	return {
		protocol: "1",
		messageId: "message-response",
		type: "worker.question_response",
		instanceId: "process-1",
		workerId: "worker-1",
		sentAt: "2026-07-26T00:00:00.000Z",
		payload: {
			turnRecordId: "turn-1",
			toolCallId: "tool-1",
			answers: ["Safe"],
			...overrides,
		},
	};
}

describe("WorkerQuestionBridge", () => {
	it("emits, replays, and resolves only a correlated response", async () => {
		const project = vi.fn();
		const bridge = new WorkerQuestionBridge({ project } as never);
		const pending = bridge.request({
			turnRecordId: "turn-1",
			toolCallId: "tool-1",
			questions,
			signal: new AbortController().signal,
		});

		expect(project).toHaveBeenCalledTimes(1);
		expect(project.mock.calls[0]?.[0]).toMatchObject({
			kind: "protocol",
			type: "worker.question_requested",
			payload: { turnRecordId: "turn-1", toolCallId: "tool-1" },
		});

		bridge.replay();
		expect(project).toHaveBeenCalledTimes(2);
		expect(bridge.handle(response({ toolCallId: "other-tool" }))).toBe(false);
		expect(bridge.handle(response())).toBe(true);
		await expect(pending).resolves.toEqual(["Safe"]);
		expect(bridge.handle(response())).toBe(false);
	});

	it("rejects pending requests when the turn is aborted", async () => {
		const controller = new AbortController();
		const bridge = new WorkerQuestionBridge({ project: vi.fn() } as never);
		const pending = bridge.request({
			turnRecordId: "turn-1",
			toolCallId: "tool-1",
			questions,
			signal: controller.signal,
		});

		controller.abort();

		await expect(pending).rejects.toThrow("turn stopped");
		expect(bridge.handle(response())).toBe(false);
	});
});
