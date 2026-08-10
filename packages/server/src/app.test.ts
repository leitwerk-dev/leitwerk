import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import { describe, expect, it } from "vitest";
import { createAppContext } from "./app.js";
import { getDefaultConfig } from "./config/index.js";

describe("createAppContext", () => {
	it("keeps raw project repos silent and emits project updates through the mutation service", async () => {
		const config = getDefaultConfig();
		config.storage.sqlite_path = ":memory:";
		const ctx = await createAppContext({
			config,
			logger: false,
			extensionCatalog: buildExtensionCatalogFromModules([]),
		});
		try {
			const frames: Array<Parameters<typeof ctx.broadcaster.broadcast>[0]> = [];
			ctx.broadcaster.broadcast = (frame) => {
				frames.push(frame);
			};
			const process = ctx.deps.processes.create({ processId: "demo_process" });
			const project = ctx.deps.projects.create({
				instanceId: process.id,
				key: "app",
				repoLocator: "https://example.com/app.git",
				baseBranch: "main",
				workBranch: "feature/demo",
			});

			ctx.deps.projects.update(project.id, { externalId: "42" });

			expect(frames.filter((frame) => frame.type === "project.updated")).toEqual([]);

			ctx.projectMutations.update(project.id, { externalId: "43" });

			const projectFrames = frames.filter((frame) => frame.type === "project.updated");
			expect(projectFrames.at(-1)).toMatchObject({
				instanceId: process.id,
				payload: {
					projectId: "app",
					project: {
						key: "app",
						externalId: "43",
						branch: "feature/demo",
					},
				},
			});
			expect(projectFrames.at(-1)?.payload).not.toHaveProperty("changedFields");
		} finally {
			await ctx.app.close();
		}
	});

	it("fails fast when process watcher config omits required fields", async () => {
		const config = getDefaultConfig();
		config.process_configs = {
			poem_creator_process: {
				turn_configs: {},
				watchers: {
					create_poem: {
						type: "filesystem",
						enabled: true,
						file_path: "/tmp/create-poem",
					} as never,
				},
			},
		};

		await expect(
			createAppContext({
				config,
				extensionCatalog: buildExtensionCatalogFromModules([]),
			}),
		).rejects.toThrow(
			/process_configs\.poem_creator_process\.watchers\.create_poem\.poll_interval/,
		);
	});

	it("reports readiness only after every start hook succeeds and clears it before stop hooks", async () => {
		let releaseStart: (() => void) | undefined;
		let readyDuringStop: boolean | undefined;
		const startGate = new Promise<void>((resolve) => {
			releaseStart = resolve;
		});
		const config = getDefaultConfig();
		config.storage.sqlite_path = ":memory:";
		let ctx: Awaited<ReturnType<typeof createAppContext>>;
		const extensionCatalog = await buildExtensionCatalogFromModules([
			{
				manifest: { id: "readiness-test", version: "1.0.0" },
				setupServer(api) {
					api.onStart(() => startGate);
					api.onStop(() => {
						readyDuringStop = ctx.isReady();
					});
				},
			},
		]);
		ctx = await createAppContext({ config, logger: false, extensionCatalog });
		try {
			expect((await ctx.app.inject({ url: "/api/health" })).statusCode).toBe(200);
			expect((await ctx.app.inject({ url: "/api/ready" })).statusCode).toBe(503);

			const starting = ctx.startBackgroundServices();
			await Promise.resolve();
			expect((await ctx.app.inject({ url: "/api/ready" })).statusCode).toBe(503);
			releaseStart?.();
			await starting;
			expect((await ctx.app.inject({ url: "/api/ready" })).statusCode).toBe(200);

			await ctx.stopBackgroundServices();
			expect(readyDuringStop).toBe(false);
			expect((await ctx.app.inject({ url: "/api/ready" })).statusCode).toBe(503);
		} finally {
			releaseStart?.();
			await ctx.app.close();
		}
	});

	it("stays unready when a start hook fails", async () => {
		const config = getDefaultConfig();
		config.storage.sqlite_path = ":memory:";
		const extensionCatalog = await buildExtensionCatalogFromModules([
			{
				manifest: { id: "failed-start", version: "1.0.0" },
				setupServer(api) {
					api.onStart(() => {
						throw new Error("start rejected");
					});
				},
			},
		]);
		const ctx = await createAppContext({ config, logger: false, extensionCatalog });
		try {
			await expect(ctx.startBackgroundServices()).rejects.toThrow("start rejected");
			expect(ctx.isReady()).toBe(false);
			expect((await ctx.app.inject({ url: "/api/ready" })).statusCode).toBe(503);
		} finally {
			await ctx.app.close();
		}
	});
});
