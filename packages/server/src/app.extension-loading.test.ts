import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveExtensionEntries } from "@leitwerk-dev/extension-runtime";
import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import {
	builtinPiProvider,
	defineModelProvider,
	defineModelProviders,
} from "@leitwerk-dev/process-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { createAppContext } from "./app.js";
import { getDefaultConfig } from "./config/config-loader.js";

const tempDirs: string[] = [];
const originalCwd = process.cwd();

afterEach(async () => {
	process.chdir(originalCwd);
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createExtensionWorkspace(): Promise<string> {
	const root = await mkdtemp(path.join(os.tmpdir(), "leitwerk-server-extension-loading-"));
	tempDirs.push(root);
	await mkdir(path.join(root, "extensions", "example", "src"), { recursive: true });
	await writeFile(
		path.join(root, "package.json"),
		JSON.stringify({
			name: "workspace-root",
			private: true,
			workspaces: ["extensions/*"],
		}),
	);
	await writeFile(
		path.join(root, "extensions", "example", "package.json"),
		JSON.stringify({
			name: "@example/example",
			type: "module",
			leitwerk: {
				extension: {
					source: "./src/index.ts",
					import: "./src/index.ts",
				},
			},
		}),
	);
	await writeFile(
		path.join(root, "extensions", "example", "src", "index.ts"),
		["export default {", "\tmanifest: { id: 'example', version: '0.1.0' },", "};", ""].join("\n"),
	);
	return root;
}

describe("createAppContext extension loading", () => {
	it.each([
		false,
		true,
	])("loads configured sources with pre-resolved entries: %s", async (preResolved) => {
		const workspaceRoot = await createExtensionWorkspace();
		const nestedCwd = path.join(workspaceRoot, "packages", "server");
		await mkdir(nestedCwd, { recursive: true });
		process.chdir(nestedCwd);

		const config = getDefaultConfig();
		config.storage.sqlite_path = ":memory:";
		config.extension_loading.sources = ["./extensions/example"];
		config.server.base_url = "http://127.0.0.1:8080";
		const resolvedExtensionEntries = preResolved
			? await resolveExtensionEntries({
					startDir: workspaceRoot,
					sources: config.extension_loading.sources,
				})
			: undefined;
		if (preResolved) config.extension_loading.sources = ["./missing-after-resolution"];

		const ctx = await createAppContext({
			config,
			logger: false,
			extensionLoadingStartDir: workspaceRoot,
			resolvedExtensionEntries,
		});
		try {
			expect(ctx.extensionCatalog.modules.map((module) => module.packageName)).toEqual([
				"@example/example",
			]);
		} finally {
			await ctx.app.close();
		}
	});

	it("collects credentialless providers before services and exposes their model status", async () => {
		const provider = defineModelProvider({
			id: "test-provider",
			parseConfig: (raw) => ({ config: raw as { endpoint: string } }),
			worker: builtinPiProvider("test-provider"),
			server: builtinPiProvider("test-provider"),
			models: () => [{ modelId: "model", availability: "available" }],
			secrets: () => ({}),
		});
		const extensionCatalog = await buildExtensionCatalogFromModules([
			{
				manifest: { id: "provider-owner", version: "1.0.0" },
				modelProviders: defineModelProviders((rawConfig) => [{ definition: provider, rawConfig }]),
			},
		]);
		const config = getDefaultConfig();
		config.storage.sqlite_path = ":memory:";
		config.extensions = { "provider-owner": { endpoint: "https://provider.invalid" } };
		config.pi.model_profiles = [{ id: "profile", provider: "test-provider", model_id: "model" }];

		const ctx = await createAppContext({ config, extensionCatalog, logger: false });
		try {
			expect(ctx.modelProviderRegistry.require("test-provider").config).toEqual({
				endpoint: "https://provider.invalid",
			});
			expect(ctx.modelStatusCache.get("profile")).toEqual(
				expect.objectContaining({ availability: "available" }),
			);
		} finally {
			await ctx.app.close();
		}
	});

	it("rejects a configured profile whose provider extension is not loaded", async () => {
		const config = getDefaultConfig();
		config.storage.sqlite_path = ":memory:";
		config.pi.model_profiles = [{ id: "profile", provider: "missing-provider", model_id: "model" }];
		const extensionCatalog = await buildExtensionCatalogFromModules([]);

		await expect(createAppContext({ config, extensionCatalog, logger: false })).rejects.toThrow(
			/names unknown provider 'missing-provider'/,
		);
	});
});
