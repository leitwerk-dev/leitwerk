import { statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	buildExtensionCatalog,
	importExtensionModules,
} from "../packages/extension-runtime/src/extension-loader.ts";
import { createAppContext } from "../packages/server/src/app.ts";
import { loadConfig } from "../packages/server/src/config/config-loader.ts";
import {
	backupProductionDatabase,
	deploymentPreflightConfig,
} from "../packages/server/src/deployment-preflight.ts";
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
	const scratchRoot = await mkdtemp(path.join(tmpdir(), "leitwerk-dev-preflight-"));
	try {
		const sourcePath = runtimeServer.config.storage.sqlite_path;
		const databaseCopyPath =
			sourcePath === ":memory:" ? sourcePath : path.join(scratchRoot, "leitwerk.sqlite");
		if (sourcePath !== ":memory:" && statSync(sourcePath, { throwIfNoEntry: false })) {
			await backupProductionDatabase({ sourcePath, destinationPath: databaseCopyPath });
		}
		const appContext = await createAppContext({
			config: deploymentPreflightConfig(runtimeServer.config, scratchRoot, databaseCopyPath),
			extensionCatalog,
			resolvedExtensionEntries: context.extensions,
		});
		try {
			// Validate routes without binding a port or starting background services.
			await appContext.app.ready();
		} finally {
			await appContext.close();
		}
	} finally {
		await rm(scratchRoot, { recursive: true, force: true });
	}
}

void main().catch((error) => {
	console.error(error instanceof Error ? (error.stack ?? error.message) : error);
	process.exit(1);
});
