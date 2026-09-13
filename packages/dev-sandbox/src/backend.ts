import { createSandboxApp } from "./index.js";
import { loadSandboxRuntime } from "./runtime.js";

const { input, config, factory } = await loadSandboxRuntime();
const sandbox = await createSandboxApp(config, input, factory);
process.once("SIGINT", () => void sandbox.stop());
process.once("SIGTERM", () => void sandbox.stop());
try {
	await sandbox.context.app.listen({ host: "127.0.0.1", port: config.server.port });
	await sandbox.context.startBackgroundServices();
	console.info(`Local controls: ${input.urls.backend}/__local`);
} catch (error) {
	await sandbox.stop();
	throw error;
}
