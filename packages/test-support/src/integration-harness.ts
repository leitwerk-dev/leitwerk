import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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

/** @public */
export interface IntegrationHarness<
	TResources extends Record<string, unknown> = Record<string, never>,
> {
	/** @public */
	ctx: AppContext;
	/** @public */
	close(): Promise<void>;
	/** @internal */
	config: LeitwerkConfig;
	/** @public */
	address: string;
	/** @internal */
	resources: TResources;
}

/** @public */
export interface IntegrationHarnessOptions<
	TResources extends Record<string, unknown> = Record<string, never>,
> {
	/** @internal */
	config?: LeitwerkConfig;
	/** @public */
	configOverride?: (config: LeitwerkConfig) => void;
	/** @public */
	appOverrides?: Partial<AppOptions>;
	/** @internal */
	listen?: boolean;
	/** Start background services when binding a listener. Defaults to true. @public */
	backgroundServices?: boolean;
	/** @internal */
	inProcessWorkers?: boolean;
	/** @public */
	extensionCatalog: ExtensionCatalog | Promise<ExtensionCatalog>;
	/** @internal */
	preProvidedCapabilities?: readonly ProvidedCapability[];
	/** @internal */
	resources?: TResources;
}

/** Owns disposable file-backed storage; close retains it for the next open, dispose removes it. */
/** @internal */
export function createPersistentIntegrationFixture(
	prefix: string,
	configure?: (config: LeitwerkConfig) => void,
) {
	const root = mkdtempSync(path.join(tmpdir(), prefix));
	let harness: IntegrationHarness | undefined;
	function createConfig() {
		const config = getDefaultConfig();
		config.storage.sqlite_path = path.join(root, "state.sqlite");
		config.storage.process_workspaces_dir = path.join(root, "workspaces");
		config.storage.tree_files_dir = path.join(root, "trees");
		config.pi.agent_dir = path.join(root, "pi");
		configure?.(config);
		return config;
	}
	async function close() {
		await harness?.close();
		harness = undefined;
	}
	return {
		/** @internal */
		root,
		/** @internal */
		createConfig() {
			return createConfig();
		},
		/** @internal */
		context() {
			if (!harness) throw new Error("Fixture is not open");
			return harness.ctx;
		},
		/** @internal */
		async open(options: IntegrationHarnessOptions) {
			harness = await createIntegrationHarness({
				...options,
				config: options.config ?? createConfig(),
			});
			return harness;
		},
		/** @internal */
		async close() {
			await close();
		},
		/** @internal */
		async dispose() {
			try {
				await close();
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
	};
}
/** @public */
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
	try {
		if (opts.listen !== false || config.workers.runner === "local") {
			if (opts.backgroundServices !== false) {
				({ address } = await ctx.listen({
					host: "127.0.0.1",
					port: 0,
					useBoundAddressAsBaseUrl: true,
				}));
			} else {
				address = await ctx.app.listen({ host: "127.0.0.1", port: 0 });
				ctx.config.server.base_url = address;
			}
		}
	} catch (error) {
		await ctx.close().catch(() => {});
		throw error;
	}

	return {
		ctx,
		close: () => ctx.close(),
		config,
		address,
		resources: opts.resources ?? ({} as TResources),
	};
}
