import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createExtensionTestApp, type ExtensionTestApp } from "./helpers/test-app.js";

describe("smoke e2e", () => {
	let app: ExtensionTestApp;

	beforeAll(async () => {
		app = await createExtensionTestApp();
	});

	afterAll(async () => {
		await app.close();
	});

	it("health endpoint returns ok", async () => {
		const res = await fetch(`${app.address}/api/health`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.status).toBe("ok");
		expect(body.protocol).toBe("leitwerk/ws/v1");
	});

	it("processes list returns empty array", async () => {
		const res = await fetch(`${app.address}/api/processes`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.processes).toEqual([]);
	});

	it("websocket connects and receives hello", async () => {
		const wsUrl = `${app.address.replace("http://", "ws://")}/ws`;
		const ws = new WebSocket(wsUrl);

		const hello = await new Promise<Record<string, unknown>>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("timeout")), 5000);
			ws.onmessage = (event) => {
				clearTimeout(timer);
				resolve(JSON.parse(String(event.data)));
			};
			ws.onerror = () => {
				clearTimeout(timer);
				reject(new Error("ws error"));
			};
		});

		expect(hello.protocol).toBe("leitwerk/ws/v1");
		expect(hello.type).toBe("hello");
		expect((hello.payload as Record<string, unknown>).serverVersion).toBe("0.1.0");

		ws.close();
	});

	it("fake llm boundary is available", () => {
		expect(app.llm).toBeDefined();

		app.llm.onPrompt(() => ({ content: "plan: do something" }));
		const response = app.llm.respond("generate a plan");
		expect(response.content).toBe("plan: do something");
	});
});
