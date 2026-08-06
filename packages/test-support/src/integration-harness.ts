import type { ExtensionCatalog } from "@leitwerk-dev/extension-runtime";
import type { ProvidedCapability } from "@leitwerk-dev/process-sdk";
import {
	type AppContext,
	type AppOptions,
	createAppContext,
	getDefaultConfig,
	type LeitwerkConfig,
} from "@leitwerk-dev/server";
import { createInProcessWorkerSpawn } from "./in-process-worker.js";

export interface IntegrationHarness<
	TResources extends Record<string, unknown> = Record<string, never>,
> {
	ctx: AppContext;
	config: LeitwerkConfig;
	address: string;
	resources: TResources;
}

export interface IntegrationHarnessOptions<
	TResources extends Record<string, unknown> = Record<string, never>,
> {
	config?: LeitwerkConfig;
	configOverride?: (config: LeitwerkConfig) => void;
	appOverrides?: Partial<AppOptions>;
	listen?: boolean;
	inProcessWorkers?: boolean;
	extensionCatalog: ExtensionCatalog | Promise<ExtensionCatalog>;
	preProvidedCapabilities?: readonly ProvidedCapability[];
	resources?: TResources;
}

export async function createIntegrationHarness<
	TResources extends Record<string, unknown> = Record<string, never>,
>(opts: IntegrationHarnessOptions<TResources>): Promise<IntegrationHarness<TResources>> {
	const config = opts.config ?? getDefaultConfig();
	if (!opts.appOverrides?.workerRunnerRuntime) {
		config.workers.runner = "local";
	}
	opts.configOverride?.(config);

	const extensionCatalog = await Promise.resolve(opts.extensionCatalog);

	const appOpts: AppOptions = {
		logger: false,
		config,
		extensionCatalog,
		preProvidedCapabilities: opts.preProvidedCapabilities,
		...opts.appOverrides,
	};

	if (opts.inProcessWorkers !== false && !appOpts.localWorkerSpawnImpl) {
		appOpts.localWorkerSpawnImpl = createInProcessWorkerSpawn({
			extensionCatalog,
		});
	}
	const ctx = await createAppContext(appOpts);

	let address = "";
	if (opts.listen !== false || config.workers.runner === "local") {
		await ctx.app.listen({ host: "127.0.0.1", port: 0 });
		const info = ctx.app.server.address();
		const port = typeof info === "object" && info ? info.port : 0;
		address = `http://127.0.0.1:${port}`;
		ctx.config.server.base_url = address;
	}

	return {
		ctx,
		config,
		address,
		resources: opts.resources ?? ({} as TResources),
	};
}
