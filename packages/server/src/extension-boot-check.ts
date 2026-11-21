import { statSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type AppOptions, createAppContext } from "./app.js";
import type { LeitwerkConfig } from "./config/index.js";
import {
	backupProductionDatabase,
	checkPreflightApp,
	deploymentPreflightConfig,
} from "./deployment-preflight.js";

/** Boot extensions with disposable storage and no background services. @internal */
export async function runExtensionBootCheck(
	config: LeitwerkConfig,
	options: Pick<
		AppOptions,
		"extensionLoadingStartDir" | "extensionCatalog" | "resolvedExtensionEntries"
	>,
	mode: "boot" | "source-reload" = "boot",
): Promise<void> {
	await using scratch = await mkdtempDisposable(path.join(tmpdir(), "leitwerk-extension-boot-"));
	let sqlitePath = ":memory:";
	const sourcePath = config.storage.sqlite_path;
	if (mode === "source-reload" && sourcePath !== ":memory:") {
		sqlitePath = path.join(scratch.path, "leitwerk.sqlite");
		if (statSync(sourcePath, { throwIfNoEntry: false }))
			await backupProductionDatabase({ sourcePath, destinationPath: sqlitePath });
	}
	const app = await createAppContext({
		...options,
		config: deploymentPreflightConfig(config, scratch.path, sqlitePath),
		logger: mode === "source-reload" ? undefined : false,
	});
	await checkPreflightApp(app, mode === "boot");
}
