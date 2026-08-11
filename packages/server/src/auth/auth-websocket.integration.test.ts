import cookie from "@fastify/cookie";
import type { Actor } from "@leitwerk-dev/domain";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createInMemoryDatabase } from "../db/database.js";
import { createAllRepos } from "../db/repositories.js";
import { registerWebsocket } from "../server-bootstrap/register-websocket.js";
import { createWorkerWebSocketIpcManager } from "../supervisor/worker-websocket-ipc.js";
import { createBroadcaster } from "../ws/broadcast.js";
import { createAuthService } from "./auth-service.js";
import { testAuthConfig } from "./auth-test-helpers.js";
import { hashOpaqueToken } from "./auth-tokens.js";

async function waitForMessage(ws: WebSocket): Promise<string> {
	return await new Promise<string>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("websocket message timeout")), 2000);
		ws.once("message", (data) => {
			clearTimeout(timer);
			resolve(String(data));
		});
		ws.once("error", () => {
			clearTimeout(timer);
			reject(new Error("websocket error before message"));
		});
	});
}

async function expectRejectedWebsocketWithHeaders(
	url: string,
	headers?: Record<string, string>,
): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const ws = new WebSocket(url, headers ? { headers } : undefined);
		const timer = setTimeout(() => reject(new Error("websocket did not close")), 2000);
		ws.once("open", () => {
			clearTimeout(timer);
			ws.close();
			reject(new Error("websocket unexpectedly opened"));
		});
		ws.once("close", () => {
			clearTimeout(timer);
			resolve();
		});
		ws.once("error", () => {
			// Rejected upgrades may emit error before close in the Node WebSocket client.
		});
	});
}

async function expectRejectedWebsocket(url: string): Promise<void> {
	return expectRejectedWebsocketWithHeaders(url);
}

describe("auth WebSocket guard", () => {
	let app: FastifyInstance | null = null;

	afterEach(async () => {
		await app?.close();
		app = null;
	});

	it("rejects /ws without a session and accepts it with a valid session", async () => {
		const db = createInMemoryDatabase();
		const repos = createAllRepos(db);
		const config = testAuthConfig({ cookieName: "orch_ws_session" });
		app = Fastify({ logger: false });
		await app.register(cookie);
		await registerWebsocket(
			app,
			createBroadcaster(),
			createWorkerWebSocketIpcManager(),
			createAuthService({ config, repos }),
		);
		const address = await app.listen({ host: "127.0.0.1", port: 0 });
		const wsUrl = `${address.replace("http://", "ws://")}/ws`;

		await expectRejectedWebsocket(wsUrl);

		const rawSession = "ws-session-token";
		const actor: Actor = { id: "identity:alice", kind: "user", provider: "identity" };
		repos.authSessions.create({
			idHash: hashOpaqueToken(rawSession),
			actor,
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
		});
		await expectRejectedWebsocketWithHeaders(wsUrl, {
			cookie: `orch_ws_session=${rawSession}`,
			origin: "https://evil.example.test",
		});

		const ws = new WebSocket(wsUrl, {
			headers: {
				cookie: `orch_ws_session=${rawSession}`,
				origin: "https://leitwerk.example.test",
			},
		});
		try {
			const hello = JSON.parse(await waitForMessage(ws)) as { type: string };
			expect(hello.type).toBe("hello");
		} finally {
			ws.close();
		}
	});
});
