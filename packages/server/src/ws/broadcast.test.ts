import type { ProcessInstance } from "@leitwerk-dev/domain";
import { createDurableWsFrame, WS_PROTOCOL_VERSION } from "@leitwerk-dev/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBroadcaster, type WsClientLike, type WsFrame } from "./broadcast.js";

function makeFakeSocket(readyState = 1): WsClientLike & { sent: string[] } {
	const sent: string[] = [];
	return {
		readyState,
		send: vi.fn((data: string) => sent.push(data)),
		on: vi.fn(),
		sent,
	};
}

function createProcessPatch(partial: Partial<ProcessInstance>): Partial<ProcessInstance> {
	return partial;
}

function createProcessInstance(id: string): ProcessInstance {
	return {
		id,
		processId: "jira_issue_process",
		selectedTurnId: "generate_plan",
		lifecycleStatus: "active",
		currentExecution: null,
		planRevision: 0,
		title: null,
		externalId: null,
		externalUrl: null,
		metadata: null,
		paramsJson: null,
		stateJson: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	};
}

describe("createBroadcaster", () => {
	let broadcaster: ReturnType<typeof createBroadcaster>;

	beforeEach(() => {
		broadcaster = createBroadcaster();
	});

	it("removes client on close event", () => {
		const ws = makeFakeSocket();
		let closeHandler: (() => void) | undefined;
		ws.on.mockImplementation((event: string, handler: () => void) => {
			if (event === "close") closeHandler = handler;
		});

		broadcaster.addClient(ws);
		closeHandler?.();

		broadcaster.sendDurable("process.updated", {
			process: createProcessPatch({ lifecycleStatus: "active" }),
			changedFields: ["lifecycleStatus"],
		});
		expect(ws.sent).toHaveLength(0);
	});

	it("sends durable frames with correct envelope", () => {
		const ws = makeFakeSocket();
		broadcaster.addClient(ws);

		broadcaster.sendDurable(
			"process.updated",
			{
				process: createProcessPatch({ selectedTurnId: "generate_plan" }),
				changedFields: ["selectedTurnId"],
			},
			"agt_123",
		);

		expect(ws.sent).toHaveLength(1);
		const frame: WsFrame = JSON.parse(ws.sent[0]);
		expect(frame.protocol).toBe(WS_PROTOCOL_VERSION);
		expect(frame.type).toBe("process.updated");
		expect(frame.durability).toBe("durable");
		expect(frame.instanceId).toBe("agt_123");
		expect(frame.payload).toEqual({
			process: { selectedTurnId: "generate_plan" },
			changedFields: ["selectedTurnId"],
		});
		expect(frame.sentAt).toBeTruthy();
	});

	it("sends ephemeral frames with correct durability marker", () => {
		const ws = makeFakeSocket();
		broadcaster.addClient(ws);

		broadcaster.sendEphemeral(
			"pi.stream.delta",
			{ turnId: "turn-1", delta: "typing...", streamType: "text" },
			"agt_456",
		);

		const frame: WsFrame = JSON.parse(ws.sent[0]);
		expect(frame.durability).toBe("ephemeral");
		expect(frame.type).toBe("pi.stream.delta");
	});

	it("broadcasts to multiple clients", () => {
		const ws1 = makeFakeSocket();
		const ws2 = makeFakeSocket();
		broadcaster.addClient(ws1);
		broadcaster.addClient(ws2);

		broadcaster.sendDurable("process.created", {
			process: createProcessInstance("agt_1"),
			processId: "jira_issue_process",
		});

		expect(ws1.sent).toHaveLength(1);
		expect(ws2.sent).toHaveLength(1);
		expect(ws1.sent[0]).toBe(ws2.sent[0]);
	});

	it("skips clients that are not in OPEN state", () => {
		const openWs = makeFakeSocket(1);
		const closedWs = makeFakeSocket(3);
		broadcaster.addClient(openWs);
		broadcaster.addClient(closedWs);

		broadcaster.sendDurable("process.updated", {
			process: createProcessPatch({ lifecycleStatus: "active" }),
			changedFields: ["lifecycleStatus"],
		});

		expect(openWs.sent).toHaveLength(1);
		expect(closedWs.sent).toHaveLength(0);
	});

	it("sends nothing when no clients are connected", () => {
		expect(() =>
			broadcaster.sendDurable("process.updated", {
				process: createProcessPatch({ lifecycleStatus: "active" }),
				changedFields: ["lifecycleStatus"],
			}),
		).not.toThrow();
	});

	it("allows raw typed frame broadcast", () => {
		const ws = makeFakeSocket();
		broadcaster.addClient(ws);

		const frame: WsFrame = createDurableWsFrame({
			type: "process.event",
			payload: {
				eventType: "retry_scheduled",
				level: "info",
				message: "Retry scheduled",
			},
			instanceId: "agt_1",
			sentAt: "2026-01-01T00:00:00.000Z",
		});
		broadcaster.broadcast(frame);

		expect(ws.sent).toHaveLength(1);
		expect(JSON.parse(ws.sent[0])).toEqual(frame);
	});
});
