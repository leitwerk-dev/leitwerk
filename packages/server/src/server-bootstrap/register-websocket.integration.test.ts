import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { registerWebsocket } from "../server-bootstrap/register-websocket.js";
import { createWorkerWebSocketIpcManager } from "../supervisor/worker-websocket-ipc.js";
import { createBroadcaster } from "../ws/broadcast.js";

function wsUrl(address: string): string {
	return `${address.replace("http://", "ws://")}/ws`;
}

async function waitForOpen(ws: WebSocket): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("websocket open timeout")), 2000);
		ws.once("open", () => {
			clearTimeout(timer);
			resolve();
		});
		ws.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}

async function waitForClose(ws: WebSocket, timeoutMs = 2000): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("websocket close timeout")), timeoutMs);
		ws.once("close", () => {
			clearTimeout(timer);
			resolve();
		});
	});
}

async function createServer(heartbeatIntervalMs: number) {
	const app = Fastify({ logger: false });
	await registerWebsocket(app, createBroadcaster(), createWorkerWebSocketIpcManager(), undefined, {
		heartbeatIntervalMs,
	});
	const address = await app.listen({ host: "127.0.0.1", port: 0 });
	return { app, address };
}

describe("websocket server heartbeat", () => {
	let app: FastifyInstance | null = null;

	beforeEach(() => {
		app = null;
	});

	afterEach(async () => {
		await app?.close();
	});

	it("terminates a client that stops answering protocol pings", async () => {
		const server = await createServer(60);
		app = server.app;

		// autoPong:false suppresses the client's automatic pong reply, so the
		// server's isAlive check flips to false and the next tick terminates it.
		const ws = new WebSocket(wsUrl(server.address), { autoPong: false });
		try {
			await waitForOpen(ws);
			await waitForClose(ws);
			expect(ws.readyState).toBe(WebSocket.CLOSED);
		} finally {
			ws.terminate();
		}
	});

	it("keeps a responsive client connected across multiple heartbeats", async () => {
		const server = await createServer(40);
		app = server.app;

		// Default client auto-responds to protocol pings, so it stays alive.
		const ws = new WebSocket(wsUrl(server.address));
		try {
			await waitForOpen(ws);
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(ws.readyState).toBe(WebSocket.OPEN);
		} finally {
			ws.terminate();
		}
	});
});
