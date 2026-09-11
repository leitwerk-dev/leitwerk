import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { sanitizeWorkerSubprocessEnv } from "@leitwerk-dev/process-sdk";

/** Repository commands choose their own mode instead of inheriting the worker service mode. */
export function createRepositoryBashTool(cwd: string): ReturnType<typeof createBashToolDefinition> {
	return createBashToolDefinition(cwd, {
		spawnHook: (context) => ({
			...context,
			env: sanitizeWorkerSubprocessEnv(context.env, { NODE_ENV: undefined }),
		}),
	});
}
