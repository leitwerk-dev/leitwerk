import type { ServerToWorkerMessage } from "@leitwerk-dev/worker-protocol";
import { describe, expect, it, vi } from "vitest";
import { WorkerIntegrationToolBridge } from "./integration-tool-bridge.js";

function result(
	overrides: Partial<
		Extract<ServerToWorkerMessage, { type: "worker.integration_tool_result" }>["payload"]
	> = {},
) {
	return {
		protocol: "1",
		messageId: "message-1",
		type: "worker.integration_tool_result",
		instanceId: "instance-1",
		workerId: "worker-1",
		sentAt: "2026-08-10T00:00:00.000Z",
		payload: {
			turnRecordId: "turn-1",
			toolCallId: "call-1",
			ok: true,
			result: { value: 2 },
			...overrides,
		},
	} as Extract<ServerToWorkerMessage, { type: "worker.integration_tool_result" }>;
}

describe("WorkerIntegrationToolBridge", () => {
	it("emits, replays, and resolves a correlated server-owned tool call", async () => {
		const project = vi.fn();
		const suspendPromptGuards = vi.fn(() => vi.fn());
		const bridge = new WorkerIntegrationToolBridge({ project } as never);
		const [tool] = bridge.createTools(
			[{ name: "provider_echo", description: "Echo", parameters: { type: "object" } }],
			"turn-1",
		);
		if (!tool) throw new Error("expected integration tool");

		const pending = tool.execute({ value: 2 }, {
			toolCallId: "call-1",
			signal: new AbortController().signal,
			suspendPromptGuards,
		} as never);

		expect(project).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "worker.integration_tool_request",
				payload: {
					turnRecordId: "turn-1",
					toolCallId: "call-1",
					toolName: "provider_echo",
					args: { value: 2 },
				},
			}),
		);
		bridge.replay();
		expect(project).toHaveBeenCalledTimes(2);
		expect(bridge.handle(result({ toolCallId: "other" }))).toBe(false);
		expect(bridge.handle(result())).toBe(true);
		await expect(pending).resolves.toEqual({ value: 2 });
		expect(suspendPromptGuards).toHaveBeenCalledTimes(1);
	});

	it("cancels pending calls and resumes prompt guards when a turn stops", async () => {
		const resume = vi.fn();
		const controller = new AbortController();
		const bridge = new WorkerIntegrationToolBridge({ project: vi.fn() } as never);
		const [tool] = bridge.createTools(
			[{ name: "provider_echo", description: "Echo", parameters: {} }],
			"turn-1",
		);
		if (!tool) throw new Error("expected integration tool");
		const pending = tool.execute({}, {
			toolCallId: "call-1",
			signal: controller.signal,
			suspendPromptGuards: () => resume,
		} as never);

		controller.abort();

		await expect(pending).rejects.toThrow(/turn stopped/);
		expect(resume).toHaveBeenCalledTimes(1);
		expect(bridge.handle(result())).toBe(false);
	});
});
