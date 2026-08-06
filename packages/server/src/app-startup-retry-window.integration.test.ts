import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AppContext, type AppOptions, createAppContext } from "./app.js";
import { getDefaultConfig } from "./config/index.js";

let ctx: AppContext | null = null;

function workerSocketUrl(address: string): string {
	return `${address.replace("http://", "ws://")}/internal/workers/connect?instanceId=unknown-proc&workerId=unknown-wkr`;
}

async function waitForClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
	return await new Promise<{ code: number; reason: string }>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("websocket close timeout")), 2_000);
		ws.addEventListener("close", (event) => {
			clearTimeout(timer);
			resolve({ code: event.code, reason: event.reason });
		});
		ws.addEventListener("error", () => {
			// Some implementations emit error immediately before close for rejected sockets.
		});
	});
}

async function connectUnknownWorker(address: string): Promise<{ code: number; reason: string }> {
	const ws = new WebSocket(workerSocketUrl(address));
	return await waitForClose(ws);
}

function fakeWorkerRunnerRuntime(): NonNullable<AppOptions["workerRunnerRuntime"]> {
	return {
		runner: {
			start: vi.fn(async () => {
				throw new Error("unexpected worker start");
			}),
			stop: vi.fn(async () => {}),
			list: vi.fn(async () => []),
			adopt: vi.fn(async () => {
				throw new Error("unexpected worker adoption");
			}),
		},
		volume: {
			ensure: vi.fn(async (instanceId: string) => ({
				instanceId,
				id: `vol-${instanceId}`,
				mountPath: "/workspace",
			})),
			release: vi.fn(async () => {}),
			deleteProcessResources: vi.fn(async () => {}),
		},
	};
}

afterEach(async () => {
	await ctx?.app.close();
	ctx = null;
});

describe("startup worker reconnect retry window", () => {
	it("returns retryable close codes after listen but before background services start", async () => {
		const config = getDefaultConfig();
		config.storage.sqlite_path = ":memory:";
		ctx = await createAppContext({
			config,
			logger: false,
			extensionCatalog: buildExtensionCatalogFromModules([]),
			workerRunnerRuntime: fakeWorkerRunnerRuntime(),
		});

		const address = await ctx.app.listen({ host: "127.0.0.1", port: 0 });

		await expect(connectUnknownWorker(address)).resolves.toMatchObject({ code: 1013 });

		await ctx.startBackgroundServices();
		await expect(connectUnknownWorker(address)).resolves.toMatchObject({ code: 1008 });
	});
});
