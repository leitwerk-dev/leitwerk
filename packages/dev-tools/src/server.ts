import { createAppContext, loadConfig } from "@leitwerk-dev/server";
import { loadWorkspaceComposition } from "./composition.js";

const input = loadWorkspaceComposition(process.env.LEITWERK_COMPOSITION_PATH as string);
const loaded = loadConfig(process.env.LEITWERK_CONFIG_PATH ?? input.runtimeConfigPath);
if (!loaded.ok) throw new Error(loaded.error);
const config = loaded.config;
config.server.host = process.env.HOST ?? config.server.host;
config.server.port = Number(process.env.PORT ?? config.server.port);
config.server.base_url = process.env.LEITWERK_BASE_URL ?? config.server.base_url;
config.extension_loading.sources = [
	...new Set([...config.extension_loading.sources, ...input.extensionDirs]),
];
const context = await createAppContext({ config, extensionLoadingStartDir: input.workspaceRoot });
let stopping = false;
async function stop() {
	if (stopping) return;
	stopping = true;
	await context.stopBackgroundServices();
	await context.app.close();
}
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
try {
	await context.app.listen({ host: config.server.host, port: config.server.port });
	await context.startBackgroundServices();
} catch (error) {
	await stop();
	throw error;
}
