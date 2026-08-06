import type { ExtensionCatalog } from "@leitwerk-dev/extension-runtime";
import type { ProvidedCapability } from "@leitwerk-dev/process-sdk";
import {
	type AppContext,
	createAppContext,
	getDefaultConfig,
	type LeitwerkConfig,
} from "@leitwerk-dev/server";
import type { FastifyInstance } from "fastify";
import { FakeLlmProvider } from "./fakes/fake-llm.js";
import { createInProcessWorkerSpawn } from "./in-process-worker.js";

export interface TestAppBase {
	server: FastifyInstance;
	ctx: AppContext;
	address: string;
	llm: FakeLlmProvider;
	close: () => Promise<void>;
}

export type TestApp<TResources extends Record<string, unknown> = Record<string, never>> =
	TestAppBase & TResources;

export interface TestAppOptions<
	TResources extends Record<string, unknown> = Record<string, never>,
> {
	extensionCatalog: ExtensionCatalog | Promise<ExtensionCatalog>;
	preProvidedCapabilities?: readonly ProvidedCapability[];
	resources?: TResources;
	listen?: boolean;
	inProcessWorkers?: boolean;
	configureConfig?: (config: LeitwerkConfig) => void;
}

export async function createTestApp<
	TResources extends Record<string, unknown> = Record<string, never>,
>(opts: TestAppOptions<TResources>): Promise<TestApp<TResources>> {
	const llm = new FakeLlmProvider();
	const config = getDefaultConfig();
	config.workers.runner = "local";
	config.workers.shutdown_grace_period = "100ms";
	opts.configureConfig?.(config);

	const ctx = await createAppContext({
		logger: false,
		config,
		// Default to in-process stub workers so integration tests do not boot the
		// real Pi runtime or touch a developer's ambient Pi setup.
		extensionCatalog: opts.extensionCatalog,
		preProvidedCapabilities: opts.preProvidedCapabilities,
		...(opts.inProcessWorkers !== false
			? {
					localWorkerSpawnImpl: createInProcessWorkerSpawn({
						extensionCatalog: opts.extensionCatalog,
					}),
				}
			: {}),
	});

	let address = "";
	if (opts.listen !== false || config.workers.runner === "local") {
		await ctx.app.listen({ host: "127.0.0.1", port: 0 });
		const addressInfo = ctx.app.server.address();
		const port = typeof addressInfo === "object" && addressInfo ? addressInfo.port : 0;
		address = `http://127.0.0.1:${port}`;
		ctx.config.server.base_url = address;
	}

	return {
		server: ctx.app,
		ctx,
		address,
		llm,
		...(opts.resources ?? ({} as TResources)),
		close: async () => {
			await ctx.supervisor.shutdownAll("test_app_close");
			ctx.app.server.closeIdleConnections?.();
			ctx.app.server.closeAllConnections?.();
			await ctx.app.close();
		},
	};
}
