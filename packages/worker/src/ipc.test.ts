import {
	createIpcMessage,
	decodeWorkerToServerMessage,
	deserializeMessage,
	serializeMessage,
} from "@leitwerk-dev/worker-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebSocketWorkerIpc } from "./ipc.js";
import { FakeWorkerWebSocket as FakeWebSocket } from "./test-helpers/fake-websocket.js";

function createIpc() {
	return createWebSocketWorkerIpc({
		serverUrl: "http://127.0.0.1:8080",
		instanceId: "proc_1",
		workerId: "wkr_1",
		token: "secret-token",
	});
}

describe("createWebSocketWorkerIpc", () => {
	beforeEach(() => {
		FakeWebSocket.instances = [];
		vi.stubGlobal("WebSocket", FakeWebSocket);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("authenticates on open, queues worker messages until open, and decodes server messages", () => {
		const received: unknown[] = [];
		const errors: Error[] = [];
		const ipc = createIpc();
		ipc.onMessage((message) => received.push(message));
		ipc.onError((error) => errors.push(error));

		ipc.start();
		const socket = FakeWebSocket.instances[0];
		const url = new URL(socket.url);
		expect(url.pathname).toBe("/internal/workers/connect");
		expect(url.searchParams.get("instanceId")).toBe("proc_1");
		expect(url.searchParams.get("workerId")).toBe("wkr_1");
		expect(url.searchParams.has("token")).toBe(false);

		ipc.send(
			createIpcMessage({
				type: "worker.hello",
				instanceId: "proc_1",
				workerId: "wkr_1",
				messageId: "hello-1",
				payload: { version: "0.1.0", capabilities: [] },
			}),
		);
		expect(socket.sent).toEqual([]);

		socket.open();
		expect(socket.sent[0]).toBe("secret-token");
		const parsed = deserializeMessage(socket.sent[1]);
		expect(parsed.ok).toBe(true);
		if (parsed.ok) {
			const decoded = decodeWorkerToServerMessage(parsed.message);
			expect(decoded.ok && decoded.message.type).toBe("worker.hello");
		}

		socket.receive(
			serializeMessage(
				createIpcMessage({
					type: "worker.stop",
					instanceId: "proc_1",
					workerId: "wkr_1",
					messageId: "stop-1",
					payload: { reason: "test" },
				}),
			),
		);
		expect(received).toEqual([expect.objectContaining({ type: "worker.stop" })]);
		expect(errors).toEqual([]);
	});

	it("derives secure websocket URLs from HTTPS base URLs", () => {
		createWebSocketWorkerIpc({
			serverUrl: "https://leitwerk-server:8080/base",
			instanceId: "proc_1",
			workerId: "wkr_1",
			token: "secret-token",
		}).start();

		const url = new URL(FakeWebSocket.instances[0].url);
		expect(url.protocol).toBe("wss:");
		expect(url.pathname).toBe("/internal/workers/connect");
	});

	it("preserves explicit secure websocket URLs", () => {
		createWebSocketWorkerIpc({
			serverUrl: "wss://leitwerk-server:8080/base",
			instanceId: "proc_1",
			workerId: "wkr_1",
			token: "secret-token",
		}).start();

		expect(new URL(FakeWebSocket.instances[0].url).protocol).toBe("wss:");
	});

	it("does not report an error when stopped intentionally", () => {
		const errors: Error[] = [];
		const ipc = createIpc();
		ipc.onError((error) => errors.push(error));
		ipc.start();

		ipc.stop();

		expect(errors).toEqual([]);
	});

	it("reports unexpected websocket closes", () => {
		const errors: Error[] = [];
		const ipc = createIpc();
		ipc.onError((error) => errors.push(error));
		ipc.start();

		FakeWebSocket.instances[0].close();

		expect(errors).toEqual([expect.objectContaining({ message: expect.any(String) })]);
	});

	it("reconnects with backoff and buffers outbound messages when reconnect mode is enabled", async () => {
		vi.useFakeTimers();
		try {
			const errors: Error[] = [];
			const connects: string[] = [];
			const ipc = createWebSocketWorkerIpc({
				serverUrl: "http://127.0.0.1:8080",
				instanceId: "proc_1",
				workerId: "wkr_1",
				token: "secret-token",
				reconnect: true,
			});
			ipc.onError((error) => errors.push(error));
			ipc.onConnect(() => connects.push("connected"));
			ipc.start();
			const first = FakeWebSocket.instances[0];
			first.open();
			first.close(1001, "server restart");
			ipc.send(
				createIpcMessage({
					type: "worker.heartbeat",
					instanceId: "proc_1",
					workerId: "wkr_1",
					messageId: "hb-reconnect",
					payload: {
						state: "idle",
						lastSequenceConsumed: 0,
						currentSelectedTurnId: null,
					},
				}),
			);

			await vi.advanceTimersByTimeAsync(100);
			const second = FakeWebSocket.instances[1];
			second.open();

			expect(second.sent[0]).toBe("secret-token");
			expect(second.sent).toHaveLength(2);
			expect(connects).toEqual(["connected"]);
			expect(errors).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("reports websocket send failures", () => {
		const errors: Error[] = [];
		const ipc = createIpc();
		ipc.onError((error) => errors.push(error));
		ipc.start();
		const socket = FakeWebSocket.instances[0];
		socket.open();
		socket.throwOnSend = true;

		ipc.send(
			createIpcMessage({
				type: "worker.heartbeat",
				instanceId: "proc_1",
				workerId: "wkr_1",
				messageId: "hb-1",
				payload: {
					state: "idle",
					lastSequenceConsumed: 0,
					currentSelectedTurnId: null,
				},
			}),
		);

		expect(errors).toEqual([expect.objectContaining({ message: "send failed" })]);
	});
});
