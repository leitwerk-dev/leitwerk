import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AppContext, createAppContext } from "./app.js";
import { getDefaultConfig } from "./config/index.js";
import { fakeWorkerRunnerRuntime } from "./test-helpers/worker-runner-runtime.js";

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

afterEach(async () => {
	await ctx?.close();
	ctx = null;
});

describe("startup worker reconnect retry window", () => {
	it("returns retryable close codes while startup adoption is pending", async () => {
		const config = getDefaultConfig();
		config.storage.sqlite_path = ":memory:";
		const runtime = fakeWorkerRunnerRuntime();
		ctx = await createAppContext({
			config,
			logger: false,
			extensionCatalog: buildExtensionCatalogFromModules([]),
			workerRunnerRuntime: runtime,
		});

		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		vi.mocked(runtime.runner.list).mockImplementation(async () => {
			entered.resolve();
			await gate.promise;
			return [];
		});
		const starting = ctx.listen({ host: "127.0.0.1", port: 0, useBoundAddressAsBaseUrl: true });
		try {
			await entered.promise;
			await expect(connectUnknownWorker(ctx.config.server.base_url)).resolves.toMatchObject({
				code: 1013,
			});
		} finally {
			gate.resolve();
			await starting;
		}
		await expect(connectUnknownWorker(ctx.config.server.base_url)).resolves.toMatchObject({
			code: 1008,
		});
	});
});
