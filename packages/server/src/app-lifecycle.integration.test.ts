import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import { coreHostCapabilities, type LeitwerkExtensionModule } from "@leitwerk-dev/process-sdk";
import { emptyPollResult } from "@leitwerk-dev/watcher-utils";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { type AppOptions, createAppContext } from "./app.js";
import { getDefaultConfig } from "./config/index.js";
import { closeDatabase, createInMemoryDatabase } from "./db/database.js";
import { fakeWorkerRunnerRuntime } from "./test-helpers/worker-runner-runtime.js";

async function context(
	options: AppOptions = {},
	setupServer?: LeitwerkExtensionModule["setupServer"],
) {
	const config = getDefaultConfig();
	config.storage.sqlite_path = ":memory:";
	config.server.host = "127.0.0.1";
	config.server.port = 0;
	config.workers.runner = "local";
	return createAppContext({
		logger: false,
		config,
		extensionCatalog: buildExtensionCatalogFromModules(
			setupServer ? [{ manifest: { id: "lifecycle-test", version: "1.0.0" }, setupServer }] : [],
		),
		...options,
	});
}

describe("AppContext lifecycle", () => {
	it("coalesces startup, preserves the configured URL and reuses the listener", async () => {
		const ctx = await context();
		const url = ctx.config.server.base_url;
		try {
			const [first, second] = await Promise.all([ctx.listen(), ctx.listen(), ctx.listen()]);
			expect(first).toEqual(second);
			expect(first.port).toBeGreaterThan(0);
			expect(first.address).toBe(`http://127.0.0.1:${first.port}`);
			expect(ctx.config.server.base_url).toBe(url);
			expect((await fetch(`${first.address}/api/ready`)).status).toBe(200);
			await expect(ctx.listen({ port: first.port })).rejects.toThrow("Conflicting");
			expect(ctx.isReady()).toBe(true);
			expect(await ctx.listen()).toEqual(first);
			expect(ctx.isReady()).toBe(true);
		} finally {
			await ctx.close();
		}
	});

	it("updates the fixture URL before reconciliation and gates readiness on start hooks", async () => {
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const runtime = fakeWorkerRunnerRuntime();
		const ctx = await context({ workerRunnerRuntime: runtime }, (api) => {
			api.onStart(() => {
				entered.resolve();
				return gate.promise;
			});
		});
		vi.mocked(runtime.runner.list).mockImplementation(async () => {
			expect(ctx.config.server.base_url).toMatch(/^http:\/\/127\.0\.0\.1:[1-9]\d*$/);
			return [];
		});
		const starting = ctx.listen({ useBoundAddressAsBaseUrl: true });
		try {
			await entered.promise;
			expect((await fetch(`${ctx.config.server.base_url}/api/ready`)).status).toBe(503);
			gate.resolve();
			await starting;
			await ctx.listen();
			expect(runtime.runner.list).toHaveBeenCalledTimes(1);
			expect(ctx.isReady()).toBe(true);
		} finally {
			gate.resolve();
			await ctx.close();
		}
	});

	it("waits for the active startup step, skips later hooks, and shares close", async () => {
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const later = vi.fn();
		const stopped = vi.fn();
		const ctx = await context({}, (api) => {
			api.onStart(() => {
				entered.resolve();
				return gate.promise;
			});
			api.onStart(later);
			api.onStop(stopped);
		});
		const starting = ctx.listen();
		const rejected = expect(starting).rejects.toThrow("interrupted");
		await entered.promise;
		const closing = ctx.close();
		expect(ctx.close()).toBe(closing);
		expect(ctx.isReady()).toBe(false);
		expect(stopped).not.toHaveBeenCalled();
		gate.resolve();
		await Promise.all([closing, rejected]);
		expect(later).not.toHaveBeenCalled();
		expect(stopped).toHaveBeenCalledTimes(1);
		expect(ctx.close()).toBe(closing);
		await expect(ctx.listen()).rejects.toThrow("closed");
	});

	it("supports close before listen and rejects adoption of a raw listener", async () => {
		const closed = await context();
		await closed.close();
		await expect(closed.listen()).rejects.toThrow("closed");
		const raw = await context();
		try {
			await raw.app.listen({ host: "127.0.0.1", port: 0 });
			await expect(raw.listen()).rejects.toThrow("manually bound");
			expect(raw.isReady()).toBe(false);
		} finally {
			await raw.close();
		}
	});

	it("rejects unsupported bound URL changes before binding", async () => {
		const ctx = await context();
		try {
			await expect(ctx.listen({ host: "0.0.0.0", useBoundAddressAsBaseUrl: true })).rejects.toThrow(
				"loopback",
			);
			expect(ctx.app.server.listening).toBe(false);
			await ctx.listen();
		} finally {
			await ctx.close();
		}
	});

	it("closes after bind or reconciliation failure", async () => {
		const first = await context();
		const occupied = await first.listen();
		const second = await context();
		try {
			await expect(second.listen({ port: occupied.port })).rejects.toThrow("EADDRINUSE");
			await expect(second.listen()).rejects.toThrow("closed");
		} finally {
			await Promise.all([first.close(), second.close()]);
		}
		const runtime = fakeWorkerRunnerRuntime();
		vi.mocked(runtime.runner.list).mockRejectedValue(new Error("adoption failed"));
		const ctx = await context({ workerRunnerRuntime: runtime });
		await expect(ctx.listen()).rejects.toThrow("adoption failed");
		expect(ctx.app.server.listening).toBe(false);
		await ctx.close();
	});

	it("preserves startup errors, attempts every stop hook and remembers failed cleanup", async () => {
		const events: string[] = [];
		const failure = new Error("start failed");
		const ctx = await context({}, (api) => {
			api.onStart(() => {
				throw failure;
			});
			api.onStop(() => {
				events.push("first");
			});
			api.onStop(() => {
				events.push("second");
				throw new Error("stop failed");
			});
		});
		const workerClose = vi.spyOn(ctx.supervisor, "shutdownAll");
		await expect(ctx.listen()).rejects.toMatchObject({ cause: failure });
		expect(events).toEqual(["second", "first"]);
		expect(workerClose).toHaveBeenCalledWith("server_shutdown");
		await expect(ctx.close()).rejects.toThrow("cleanup failed");
		await expect(ctx.close()).rejects.toThrow("cleanup failed");
		expect(events).toHaveLength(2);
		expect(ctx.app.server.listening).toBe(false);
		expect(() => ctx.deps.processes.listAll()).toThrow();
	});

	it("drains active HTTP requests and closes WebSockets", async () => {
		const ctx = await context();
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		ctx.app.get("/slow", async () => {
			entered.resolve();
			await gate.promise;
			expect(ctx.deps.processes.listAll()).toEqual([]);
			return "finished";
		});
		const { address } = await ctx.listen();
		const ws = new WebSocket(`${address.replace("http:", "ws:")}/ws`);
		await new Promise<void>((resolve, reject) => {
			ws.once("open", resolve);
			ws.once("error", reject);
		});
		const disconnected = new Promise<void>((resolve) => ws.once("close", () => resolve()));
		const request = fetch(`${address}/slow`).then((response) => response.text());
		await entered.promise;
		const closing = ctx.close();
		expect(ctx.isReady()).toBe(false);
		gate.resolve();
		expect(await request).toBe("finished");
		await Promise.all([closing, disconnected]);
	});

	it("waits for in-flight polling before closing the database", async () => {
		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		let readAfterStop: (() => void) | undefined;
		const ctx = await context({}, (api) => {
			const deps = api.require(coreHostCapabilities.serverSetup);
			if (Array.isArray(deps)) throw new Error("expected one capability");
			deps.polling.create({
				id: "gated",
				isEnabled: () => true,
				pollInterval: () => "1h",
				async pollOnce() {
					entered.resolve();
					await gate.promise;
					readAfterStop?.();
					return emptyPollResult();
				},
			});
		});
		readAfterStop = () => expect(ctx.deps.processes.listAll()).toEqual([]);
		await ctx.listen();
		await entered.promise;
		const closing = ctx.close();
		gate.resolve();
		await closing;
		expect(() => ctx.deps.processes.listAll()).toThrow();
	});

	it("formats an IPv6 loopback URL", async () => {
		const ctx = await context();
		try {
			const result = await ctx.listen({ host: "::1", useBoundAddressAsBaseUrl: true });
			expect(result.address).toBe(`http://[::1]:${result.port}`);
			expect(ctx.config.server.base_url).toBe(result.address);
		} finally {
			await ctx.close();
		}
	});

	it("cleans up acquired extension resources when construction fails", async () => {
		const events: string[] = [];
		const db = createInMemoryDatabase();
		try {
			await expect(
				context({ db }, (api) => {
					api.onStop(() => {
						events.push("first");
					});
					api.onStop(() => {
						events.push("second");
						throw new Error("construction stop failed");
					});
					throw new Error("construction failed");
				}),
			).rejects.toMatchObject({
				cause: expect.objectContaining({ message: expect.stringContaining("construction failed") }),
			});
			expect(events).toEqual(["second", "first"]);
			expect(db.$client.prepare("SELECT 1 AS value").get()).toMatchObject({ value: 1 });
		} finally {
			closeDatabase(db);
		}
	});

	it("uses isolated detach and shares cleanup with direct Fastify close", async () => {
		const ctx = await context();
		ctx.config.workers.runner = "docker";
		const detach = vi.spyOn(ctx.supervisor, "detachAll");
		const shutdown = vi.spyOn(ctx.supervisor, "shutdownAll");
		await ctx.app.close();
		await ctx.close();
		expect(detach).toHaveBeenCalledExactlyOnceWith("server_shutdown");
		expect(shutdown).not.toHaveBeenCalled();
	});

	it("preserves injected databases and durable file-backed records", async () => {
		const db = createInMemoryDatabase();
		const injected = await context({ db });
		await injected.close();
		expect(injected.deps.processes.listAll()).toEqual([]);
		closeDatabase(db);
		const root = await mkdtemp(path.join(os.tmpdir(), "lifecycle-"));
		const config = getDefaultConfig();
		config.storage.sqlite_path = path.join(root, "db.sqlite");
		config.storage.tree_files_dir = path.join(root, "trees");
		try {
			const first = await context({ config });
			const record = first.deps.processes.create({ processId: "durable" });
			await first.close();
			const second = await context({ config });
			try {
				expect(second.deps.processes.getById(record.id)).toEqual(record);
			} finally {
				await second.close();
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
