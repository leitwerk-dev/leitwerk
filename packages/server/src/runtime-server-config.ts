import type { LeitwerkConfig } from "./config/index.js";

export interface RuntimeServerEnv {
	HOST?: string;
	PORT?: string;
	LEITWERK_BASE_URL?: string;
	LEITWERK_LOCAL_WORKER_COMMAND?: string;
	LEITWERK_LOCAL_WORKER_ARGS_JSON?: string;
}

export interface ResolvedRuntimeServerConfig {
	host: string;
	port: number;
	baseUrl: string;
	config: LeitwerkConfig;
}

function resolveWorkerArgs(env: RuntimeServerEnv, config: LeitwerkConfig): string[] {
	const argsJson = env.LEITWERK_LOCAL_WORKER_ARGS_JSON;
	if (argsJson === undefined) {
		return config.local_worker?.args ?? ["@leitwerk-dev/worker/worker-entry"];
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(argsJson);
	} catch (error) {
		throw new Error(
			`LEITWERK_LOCAL_WORKER_ARGS_JSON must be a JSON string array: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
		throw new Error("LEITWERK_LOCAL_WORKER_ARGS_JSON must be a JSON string array");
	}
	return parsed;
}

export function resolveRuntimeServerConfig(
	baseConfig: LeitwerkConfig,
	env: RuntimeServerEnv = process.env,
): ResolvedRuntimeServerConfig {
	const host = env.HOST ?? baseConfig.server.host;
	const port = env.PORT === undefined ? baseConfig.server.port : Number(env.PORT);
	const baseUrl = env.LEITWERK_BASE_URL ?? baseConfig.server.base_url;
	const workerCommand =
		env.LEITWERK_LOCAL_WORKER_COMMAND ?? baseConfig.local_worker?.command ?? "node";
	const workerArgs = resolveWorkerArgs(env, baseConfig);

	return {
		host,
		port,
		baseUrl,
		config: {
			...baseConfig,
			server: {
				...baseConfig.server,
				host,
				port,
				base_url: baseUrl,
			},
			workers: {
				...baseConfig.workers,
			},
			local_worker: {
				command: workerCommand,
				args: workerArgs,
			},
		},
	};
}
