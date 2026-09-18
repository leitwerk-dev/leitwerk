import {
	createIntegrationHarness,
	type IntegrationHarness,
} from "@leitwerk-dev/test-support/integration";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDefaultTestExtensionCatalog } from "./helpers/test-extension-catalog.js";

describe("smoke e2e", () => {
	let app: IntegrationHarness;

	beforeAll(async () => {
		app = await createIntegrationHarness({
			extensionCatalog: getDefaultTestExtensionCatalog(),
			configOverride(config) {
				config.workers.shutdown_grace_period = "100ms";
			},
		});
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
});
