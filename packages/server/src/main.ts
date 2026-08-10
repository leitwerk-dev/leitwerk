import path from "node:path";
import { type AppContext, createAppContext } from "./app.js";
import { loadConfig, sanitizeConfigForLogging } from "./config/config-loader.js";
import { DatabaseSchemaMismatchError } from "./db/database.js";
import { runDeploymentPreflight } from "./deployment-preflight.js";
import { resolveRuntimeServerConfig } from "./runtime-server-config.js";

const loadedConfig = loadConfig(process.env.LEITWERK_CONFIG_PATH);
if (!loadedConfig.ok) {
	console.error(loadedConfig.error);
	process.exit(1);
}

const runtimeServer = resolveRuntimeServerConfig(loadedConfig.config);

console.info(
	[
		`Active configuration (${loadedConfig.filePath}, sensitive values redacted):`,
		JSON.stringify(
			{
				listen: { host: runtimeServer.host, port: runtimeServer.port },
				config: sanitizeConfigForLogging(runtimeServer.config),
			},
			null,
			2,
		),
	].join("\n"),
);

const extensionLoadingStartDir =
	loadedConfig.filePath === "<defaults>" ? process.cwd() : path.dirname(loadedConfig.filePath);

if (process.argv.includes("--deployment-preflight")) {
	try {
		await runDeploymentPreflight({
			config: runtimeServer.config,
			extensionLoadingStartDir,
		});
		process.exit(0);
	} catch (error) {
		console.error(error);
		process.exit(1);
	}
}

let ctx: AppContext;
try {
	ctx = await createAppContext({
		config: runtimeServer.config,
		extensionLoadingStartDir,
	});
} catch (error) {
	if (error instanceof DatabaseSchemaMismatchError) {
		console.error(error.message);
		process.exit(1);
	}
	throw error;
}

const SIGNAL_EXIT_CODES = {
	SIGINT: 130,
	SIGTERM: 143,
} as const;

let shuttingDown = false;
async function shutdown(signal: keyof typeof SIGNAL_EXIT_CODES) {
	if (shuttingDown) {
		process.exit(SIGNAL_EXIT_CODES[signal]);
	}
	shuttingDown = true;
	try {
		await ctx.stopBackgroundServices();
		await ctx.app.close();
		process.exit(SIGNAL_EXIT_CODES[signal]);
	} catch (error) {
		ctx.app.log.error(error);
		process.exit(1);
	}
}

process.once("SIGINT", () => {
	void shutdown("SIGINT");
});
process.once("SIGTERM", () => {
	void shutdown("SIGTERM");
});

try {
	const listenStartedAt = performance.now();
	await ctx.app.listen({ host: runtimeServer.host, port: runtimeServer.port });
	ctx.app.log.info(
		{ listenDurationMs: Math.round((performance.now() - listenStartedAt) * 10) / 10 },
		"Server HTTP listener ready",
	);
	await ctx.startBackgroundServices();
} catch (err) {
	ctx.app.log.error(err);
	try {
		await ctx.app.close();
	} catch (closeError) {
		ctx.app.log.error(closeError);
	}
	process.exit(1);
}
