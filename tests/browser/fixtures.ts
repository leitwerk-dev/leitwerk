import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionCatalog } from "@leitwerk-dev/extension-runtime";
import type { AppContext, LeitwerkConfig } from "@leitwerk-dev/server";
import { createAppContext, getDefaultConfig } from "@leitwerk-dev/server";
import { createInProcessWorkerSpawn } from "@leitwerk-dev/test-support/worker-testing";
import { test as base, expect, type Locator, type Page } from "@playwright/test";

const API_PORT = Number(process.env.LEITWERK_BROWSER_API_PORT);

export interface BrowserServerOptions {
	tempPrefix: string;
	configure?: (config: LeitwerkConfig, tempRoot: string) => void | Promise<void>;
	createExtensionCatalog: (
		config: LeitwerkConfig,
		tempRoot: string,
	) => ExtensionCatalog | Promise<ExtensionCatalog>;
	useInProcessWorker?: boolean;
	extensionLoadingStartDir?: string;
}

export interface BrowserServer {
	ctx: AppContext;
	tempRoot: string;
}

type BrowserWorkerFixtures = {
	browserServerOptions: BrowserServerOptions;
	leitwerk: BrowserServer;
};

export const test = base.extend<Record<string, never>, BrowserWorkerFixtures>({
	browserServerOptions: [
		{
			tempPrefix: "leitwerk-browser-",
			createExtensionCatalog: () => {
				throw new Error("browserServerOptions.createExtensionCatalog is required");
			},
		},
		{ option: true, scope: "worker" },
	],
	leitwerk: [
		async ({ browserServerOptions }, use) => {
			const tempRoot = await mkdtemp(path.join(os.tmpdir(), browserServerOptions.tempPrefix));
			let ctx: AppContext | null = null;
			try {
				const config = getDefaultConfig();
				config.workers.shutdown_grace_period = "100ms";
				config.server.base_url = `http://127.0.0.1:${process.env.LEITWERK_BROWSER_UI_PORT}`;
				await browserServerOptions.configure?.(config, tempRoot);
				const extensionCatalog = await browserServerOptions.createExtensionCatalog(
					config,
					tempRoot,
				);
				ctx = await createAppContext({
					logger: false,
					config,
					extensionCatalog,
					extensionUiRuntimeLane: "dist",
					...(browserServerOptions.useInProcessWorker
						? { localWorkerSpawnImpl: createInProcessWorkerSpawn({ extensionCatalog }) }
						: {}),
					...(browserServerOptions.extensionLoadingStartDir
						? { extensionLoadingStartDir: browserServerOptions.extensionLoadingStartDir }
						: {}),
				});
				await ctx.app.listen({ host: "127.0.0.1", port: API_PORT });
				await use({ ctx, tempRoot });
			} finally {
				if (ctx) {
					ctx.app.server.closeIdleConnections?.();
					ctx.app.server.closeAllConnections?.();
					await ctx.app.close();
				}
				await rm(tempRoot, { recursive: true, force: true });
			}
		},
		{ scope: "worker" },
	],
});

export async function box(locator: Locator) {
	const bounds = await locator.boundingBox();
	if (!bounds) throw new Error("Expected a visible layout element");
	return bounds;
}

export async function expectNoPageOverflow(page: Page) {
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
		true,
	);
}

export { expect };
