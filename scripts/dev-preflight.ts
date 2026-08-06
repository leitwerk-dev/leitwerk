import {
	buildExtensionCatalog,
	importExtensionModules,
} from "../packages/extension-runtime/src/extension-loader.ts";
import { createAppContext } from "../packages/server/src/app.ts";
import { loadConfig } from "../packages/server/src/config/config-loader.ts";
import { resolveRuntimeServerConfig } from "../packages/server/src/runtime-server-config.ts";
import { loadDevContext } from "./dev-context.ts";

async function main(): Promise<void> {
	process.env.LEITWERK_RUNTIME_LANE = "source";
	const context = await loadDevContext();
	const modules = await importExtensionModules(context.extensions);
	const extensionCatalog = await buildExtensionCatalog(modules);

	// Worker entry-runtime is import-safe, unlike worker-entry.ts, and pulls in the
	// worker composition graph without starting IPC.
	await import("../packages/worker/src/entry-runtime.ts");
	// Exercise modules intentionally deferred by the server composition root.
	await import("../packages/server/src/process-title-generator.ts");

	const loaded = loadConfig(process.env.LEITWERK_CONFIG_PATH);
	if (!loaded.ok) throw new Error(loaded.error);
	const runtimeServer = resolveRuntimeServerConfig(loaded.config, process.env);
	const appContext = await createAppContext({
		config: runtimeServer.config,
		extensionCatalog,
		resolvedExtensionEntries: context.extensions,
	});
	try {
		// Fastify readiness validates the complete route/plugin graph without
		// binding the production port or starting background services.
		await appContext.app.ready();
	} finally {
		await appContext.app.close();
	}
}

void main().catch((error) => {
	console.error(error instanceof Error ? (error.stack ?? error.message) : error);
	process.exit(1);
});
