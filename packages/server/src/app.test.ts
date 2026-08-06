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
});
