import {
	WORKER_IPC_CONNECT_TOKEN_ENV,
	WORKER_IPC_RECONNECT_ENV,
	WORKER_SNAPSHOT_TOKEN_ENV,
} from "@leitwerk-dev/worker-protocol";

export type SubprocessEnvInput = Record<string, string | undefined>;

export const INTERNAL_REPOSITORY_GIT_SSH_ENV_PREFIX = "LEITWERK_INTERNAL_REPOSITORY_GIT_SSH_";

export const WORKER_SUBPROCESS_SENSITIVE_ENV_KEYS = [
	WORKER_IPC_CONNECT_TOKEN_ENV,
	WORKER_IPC_RECONNECT_ENV,
	WORKER_SNAPSHOT_TOKEN_ENV,
] as const;

const SENSITIVE_ENV_KEYS = new Set<string>([
	...WORKER_SUBPROCESS_SENSITIVE_ENV_KEYS,
	"SSH_AUTH_SOCK",
	"SSH_AGENT_PID",
	"GIT_SSH",
	"GIT_SSH_COMMAND",
]);

/**
 * Builds an environment for worker-executed repository shell/tool commands.
 *
 * Worker IPC and session-snapshot credentials are valid only for the worker
 * process itself. Repository scripts, git hooks, package managers, and other
 * tool subprocesses must not receive them.
 */
export function sanitizeWorkerSubprocessEnv(
	baseEnv: SubprocessEnvInput = process.env,
	overrides: SubprocessEnvInput = {},
): NodeJS.ProcessEnv {
	const sanitized: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries({ ...baseEnv, ...overrides })) {
		if (
			SENSITIVE_ENV_KEYS.has(key) ||
			key.startsWith(INTERNAL_REPOSITORY_GIT_SSH_ENV_PREFIX) ||
			value === undefined
		) {
			continue;
		}
		sanitized[key] = value;
	}
	return sanitized;
}
