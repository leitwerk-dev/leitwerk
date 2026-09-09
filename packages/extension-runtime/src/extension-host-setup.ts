import type { ServerExtensionAPI, WorkerExtensionAPI } from "@leitwerk-dev/process-sdk";
import type { ExtensionCatalog } from "./extension-loader.js";

export async function setupServerExtensions(
	catalog: Pick<ExtensionCatalog, "modules">,
	api: ServerExtensionAPI,
	getConfig: (id: string) => unknown = () => ({}),
): Promise<void> {
	for (const loaded of catalog.modules) {
		const setup = loaded.module.setupServer;
		await setup?.(api, getConfig(loaded.module.manifest.id));
	}
}

export async function setupWorkerExtensions(
	catalog: Pick<ExtensionCatalog, "modules">,
	api: WorkerExtensionAPI,
	getConfig: (id: string) => unknown = () => ({}),
): Promise<void> {
	for (const loaded of catalog.modules) {
		const setup = loaded.module.setupWorker;
		await setup?.(api, getConfig(loaded.module.manifest.id));
	}
}
