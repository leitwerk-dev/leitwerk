import { mkdir } from "node:fs/promises";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { type AppContext, createAppContext } from "./app.js";
import type { LeitwerkConfig } from "./config/index.js";

const DEFAULT_SCRATCH_ROOT = "/tmp/leitwerk-deployment-preflight";

export async function backupProductionDatabase(input: {
	sourcePath: string;
	destinationPath: string;
}): Promise<void> {
	await mkdir(path.dirname(input.destinationPath), { recursive: true });
	const source = new DatabaseSync(input.sourcePath, { readOnly: true });
	try {
		await backup(source, input.destinationPath);
	} finally {
		source.close();
	}
}

export function deploymentPreflightConfig(
	config: LeitwerkConfig,
	scratchRoot: string,
	databaseCopyPath: string,
): LeitwerkConfig {
	// `artifacts_dir` is retained by the loose config schema for compatibility
	// with chart-generated configs. Keep that path off the production volume too.
	const storage = {
		...config.storage,
		sqlite_path: databaseCopyPath,
		process_workspaces_dir: path.join(scratchRoot, "workspaces"),
		tree_files_dir: path.join(scratchRoot, "trees"),
		artifacts_dir: path.join(scratchRoot, "artifacts"),
	};
	return {
		...config,
		server: {
			...config.server,
			host: "127.0.0.1",
			port: 0,
		},
		storage,
		pi: {
			...config.pi,
			agent_dir: path.join(scratchRoot, "pi"),
		},
	};
}

export async function runDeploymentPreflight(input: {
	config: LeitwerkConfig;
	extensionLoadingStartDir: string;
	scratchRoot?: string;
	createContext?: typeof createAppContext;
}): Promise<void> {
	const sourcePath = input.config.storage.sqlite_path;
	if (sourcePath === ":memory:") {
		throw new Error("Deployment preflight requires a file-backed production SQLite database");
	}
	const scratchRoot =
		input.scratchRoot ?? process.env.LEITWERK_PREFLIGHT_SCRATCH_DIR ?? DEFAULT_SCRATCH_ROOT;
	await mkdir(scratchRoot, { recursive: true });
	const databaseCopyPath = path.join(scratchRoot, "database", "leitwerk.sqlite");
	await backupProductionDatabase({ sourcePath, destinationPath: databaseCopyPath });

	const createContext = input.createContext ?? createAppContext;
	let ctx: AppContext | null = null;
	try {
		ctx = await createContext({
			config: deploymentPreflightConfig(input.config, scratchRoot, databaseCopyPath),
			extensionLoadingStartDir: input.extensionLoadingStartDir,
		});
		await ctx.app.listen({ host: "127.0.0.1", port: 0 });
		const health = await ctx.app.inject({ method: "GET", url: "/api/health" });
		if (health.statusCode !== 200 || health.json().status !== "ok") {
			throw new Error(`Deployment preflight health check failed with HTTP ${health.statusCode}`);
		}
		if (ctx.isReady()) {
			throw new Error("Deployment preflight started background services unexpectedly");
		}
	} finally {
		await ctx?.app.close();
	}
}
