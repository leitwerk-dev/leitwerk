import { createIpcMessage, serializeMessage } from "@leitwerk-dev/worker-protocol";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerWebsocket } from "../server-bootstrap/register-websocket.js";
import { createBroadcaster } from "../ws/broadcast.js";
import { hashWorkerConnectToken } from "./worker-connect-token.js";
import { createWorkerWebSocketIpcManager } from "./worker-websocket-ipc.js";

function socketUrl(address: string): string {
	return `${address.replace("http://", "ws://")}/internal/workers/connect?instanceId=proc_1&workerId=wkr_1`;
}

async function waitForOpen(ws: WebSocket): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("websocket open timeout")), 2000);
		ws.addEventListener("open", () => {
			clearTimeout(timer);
			resolve();
		});
		ws.addEventListener("error", () => {
			clearTimeout(timer);
			reject(new Error("websocket error before open"));
		});
	});
}

async function waitForMessage(ws: WebSocket): Promise<string> {
	return await new Promise<string>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("websocket message timeout")), 2000);
		ws.addEventListener("message", (event) => {
			clearTimeout(timer);
			resolve(String(event.data));
		});
		ws.addEventListener("error", () => {
			clearTimeout(timer);
			reject(new Error("websocket error before message"));
		});
	});
}

async function waitForClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
	return await new Promise<{ code: number; reason: string }>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("websocket close timeout")), 2000);
		ws.addEventListener("close", (event) => {
			clearTimeout(timer);
			resolve({ code: event.code, reason: event.reason });
		});
		ws.addEventListener("error", () => {
			// Some WebSocket implementations emit error immediately before close for policy failures.
		});
	});
}

async function createRegisteredServer(callbacks: {
	onEnvelope: (envelope: unknown) => void;
	onInvalidOutput: () => void;
	onRuntimeError: (error: unknown) => void;
}) {
	const app = Fastify({ logger: false });
	const manager = createWorkerWebSocketIpcManager();
	await registerWebsocket(app, createBroadcaster(), manager);
	const token = "persistent-token";
	manager.registerWorker({
		instanceId: "proc_1",
		workerId: "wkr_1",
		tokenHash: hashWorkerConnectToken(token),
		callbacks,
	});
	const address = await app.listen({ host: "127.0.0.1", port: 0 });
	return { app, manager, token, address };
}

describe("worker WebSocket IPC route", () => {
	let app: FastifyInstance | null = null;

	beforeEach(() => {
		app = null;
	});

	afterEach(async () => {
		await app?.close();
	});

	it("routes authenticated worker and server IPC frames over a real websocket", async () => {
		let resolveEnvelope: (envelope: unknown) => void = () => {};
		const envelopePromise = new Promise<unknown>((resolve) => {
			resolveEnvelope = resolve;
		});
		const callbacks = {
			onEnvelope: vi.fn((envelope: unknown) => resolveEnvelope(envelope)),
			onInvalidOutput: vi.fn(),
			onRuntimeError: vi.fn(),
		};
		const server = await createRegisteredServer(callbacks);
		app = server.app;
		const ws = new WebSocket(socketUrl(server.address));
		try {
			await waitForOpen(ws);
			ws.send(server.token);
			ws.send(
				serializeMessage(
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
				),
			);

			await expect(envelopePromise).resolves.toMatchObject({
				type: "worker.heartbeat",
				messageId: "hb-1",
			});

			server.manager.send(
				"proc_1",
				"wkr_1",
				createIpcMessage({
					type: "input.batch",
					instanceId: "proc_1",
					workerId: "wkr_1",
					messageId: "input-1",
					payload: {
						inputs: [
							{
								inputId: "inp_1",
								sequence: 1,
								source: "test",
								kind: "operator_message",
								target: null,
								receivedAt: new Date(0).toISOString(),
								bodyMarkdown: "hello",
							},
						],
					},
				}),
			);
			await expect(waitForMessage(ws)).resolves.toContain('"type":"input.batch"');
			expect(callbacks.onInvalidOutput).not.toHaveBeenCalled();
			expect(callbacks.onRuntimeError).not.toHaveBeenCalled();
		} finally {
			ws.close();
		}
	});

	it("rejects bad auth frames without invoking worker runtime callbacks", async () => {
		const callbacks = {
			onEnvelope: vi.fn(),
			onInvalidOutput: vi.fn(),
			onRuntimeError: vi.fn(),
		};
		const server = await createRegisteredServer(callbacks);
		app = server.app;
		const ws = new WebSocket(socketUrl(server.address));
		try {
			await waitForOpen(ws);
			ws.send("wrong-token");

			await expect(waitForClose(ws)).resolves.toMatchObject({ code: 1008 });
			expect(callbacks.onEnvelope).not.toHaveBeenCalled();
			expect(callbacks.onInvalidOutput).not.toHaveBeenCalled();
			expect(callbacks.onRuntimeError).not.toHaveBeenCalled();
		} finally {
			ws.close();
		}
	});
});
