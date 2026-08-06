import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import {
	builtinPiProvider,
	defineModelProvider,
	defineModelProviders,
} from "@leitwerk-dev/process-sdk";
import { WS_PRIMARY_PATH_TYPES, WS_PROTOCOL_VERSION } from "@leitwerk-dev/protocol";
import type { AppContext, WsFrame } from "@leitwerk-dev/server";
import showcaseProcessesExtension from "@leitwerk-dev/showcase-processes";
import { createIntegrationHarness } from "@leitwerk-dev/test-support/integration";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let ctx: AppContext;
let address: string;

const websocketFixtureProviderExtension = {
	manifest: { id: "websocket-fixture-provider", version: "1.0.0" },
	modelProviders: defineModelProviders((rawConfig) => [
		{
			definition: defineModelProvider({
				id: "openai",
				parseConfig: () => ({ config: {} }),
				worker: builtinPiProvider("openai"),
				server: builtinPiProvider("openai"),
				models: () => [{ modelId: "gpt-5", availability: "available" }],
				secrets: () => ({}),
			}),
			rawConfig,
		},
	]),
};

function wsUrl(): string {
	return `${address.replace("http://", "ws://")}/ws`;
}

async function connectWs(): Promise<{ ws: WebSocket; hello: WsFrame }> {
	const ws = new WebSocket(wsUrl());

	const hello = await new Promise<WsFrame>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("ws connect timeout")), 2000);
		ws.onmessage = (event) => {
			const frame = JSON.parse(String(event.data)) as WsFrame;
			if (frame.type === "hello") {
				clearTimeout(timer);
				resolve(frame);
			}
		};
		ws.onerror = () => {
			clearTimeout(timer);
			reject(new Error("ws error"));
		};
	});

	return { ws, hello };
}

async function waitForFrame(
	ws: WebSocket,
	predicate: (frame: WsFrame) => boolean,
	timeoutMs = 2_000,
): Promise<WsFrame> {
	return await new Promise<WsFrame>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("ws frame timeout")), timeoutMs);
		ws.onmessage = (event) => {
			const frame = JSON.parse(String(event.data)) as WsFrame;
			if (predicate(frame)) {
				clearTimeout(timer);
				resolve(frame);
			}
		};
		ws.onerror = () => {
			clearTimeout(timer);
			reject(new Error("ws error"));
		};
	});
}

beforeAll(async () => {
	const harness = await createIntegrationHarness({
		extensionCatalog: buildExtensionCatalogFromModules([
			showcaseProcessesExtension,
			websocketFixtureProviderExtension,
		]),
		configOverride(config) {
			config.pi.model_profiles = [
				{
					id: "deep-reasoning",
					provider: "openai",
					model_id: "gpt-5",
					thinking_level: "high",
				},
			];
		},
	});
	ctx = harness.ctx;
	address = harness.address;
});

afterAll(async () => {
	await ctx.app.close();
});

describe("WebSocket protocol contract", () => {
	it("sends hello on connect", async () => {
		const { ws, hello } = await connectWs();
		try {
			expect(hello).toMatchObject({
				protocol: WS_PROTOCOL_VERSION,
				type: "hello",
				durability: "ephemeral",
			});
			expect((hello.payload as { serverVersion?: unknown }).serverVersion).toEqual(
				expect.any(String),
			);
		} finally {
			ws.close();
		}
	});

	it("responds to ping with pong", async () => {
		const { ws } = await connectWs();
		try {
			const pongPromise = waitForFrame(ws, (frame) => frame.type === "pong");
			ws.send(JSON.stringify({ type: "ping" }));
			const pong = await pongPromise;
			expect(pong).toMatchObject({
				protocol: WS_PROTOCOL_VERSION,
				type: "pong",
				durability: "ephemeral",
				payload: {},
			});
		} finally {
			ws.close();
		}
	});

	it("ignores malformed inbound frames and keeps the connection alive", async () => {
		const { ws } = await connectWs();
		try {
			const pongPromise = waitForFrame(ws, (frame) => frame.type === "pong");
			ws.send("{not-json");
			ws.send(JSON.stringify({ type: "ping" }));
			const pong = await pongPromise;
			expect(pong.type).toBe("pong");
		} finally {
			ws.close();
		}
	});

	it("delivers broadcaster frames to connected websocket clients", async () => {
		const { ws } = await connectWs();
		try {
			const framePromise = waitForFrame(ws, (frame) => frame.type === "process.updated");
			ctx.broadcaster.sendDurable(
				"process.updated",
				{ process: { selectedTurnId: "run_single_prompt" } },
				"agt_test",
			);
			const frame = await framePromise;
			expect(frame).toMatchObject({
				protocol: WS_PROTOCOL_VERSION,
				type: "process.updated",
				durability: "durable",
				instanceId: "agt_test",
				payload: { process: { selectedTurnId: "run_single_prompt" } },
			});
		} finally {
			ws.close();
		}
	});

	it("delivers normalized primary-path frames from committed server mutations", async () => {
		const process = ctx.deps.processes.create({
			processId: "single_prompt_process",
			selectedTurnId: "run_single_prompt",
			lifecycleStatus: "active",
		});
		const { ws } = await connectWs();
		try {
			const framePromise = waitForFrame(
				ws,
				(frame) => frame.type === WS_PRIMARY_PATH_TYPES.CHANGED && frame.instanceId === process.id,
			);
			const result = await ctx.deps.processEngine.updateSemanticEntryRefs(process.id, {
				rootEntry: { entryId: "root-user", turnRecordId: null },
				currentPrimaryPathLeaf: { entryId: "assistant-1", turnRecordId: null },
			});
			expect(result.ok).toBe(true);
			const frame = await framePromise;
			expect(frame).toMatchObject({
				protocol: WS_PROTOCOL_VERSION,
				type: WS_PRIMARY_PATH_TYPES.CHANGED,
				durability: "durable",
				instanceId: process.id,
				payload: {
					rootEntry: { entryId: "root-user", turnRecordId: null },
					currentLeaf: { entryId: "assistant-1", turnRecordId: null },
				},
			});
		} finally {
			ws.close();
		}
	});
});
