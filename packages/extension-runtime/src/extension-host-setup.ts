import type {
	LeitwerkExtensionModule,
	ServerExtensionAPI,
	WorkerExtensionAPI,
} from "@leitwerk-dev/process-sdk";
import type { ExtensionCatalog } from "./extension-loader.js";

async function setupExtensions<TApi>(
	catalog: Pick<ExtensionCatalog, "modules">,
	api: TApi,
	selectSetup: (
		module: LeitwerkExtensionModule,
	) => ((api: TApi, config: unknown) => void | Promise<void>) | undefined,
	getConfig: (id: string) => unknown = () => ({}),
): Promise<void> {
	for (const loaded of catalog.modules) {
		await selectSetup(loaded.module)?.(api, getConfig(loaded.module.manifest.id));
	}
}

export async function setupServerExtensions(
	catalog: Pick<ExtensionCatalog, "modules">,
	api: ServerExtensionAPI,
	getConfig: (id: string) => unknown = () => ({}),
): Promise<void> {
	await setupExtensions(catalog, api, (module) => module.setupServer, getConfig);
}

export async function setupWorkerExtensions(
	catalog: Pick<ExtensionCatalog, "modules">,
	api: WorkerExtensionAPI,
	getConfig: (id: string) => unknown = () => ({}),
): Promise<void> {
	await setupExtensions(catalog, api, (module) => module.setupWorker, getConfig);
}
