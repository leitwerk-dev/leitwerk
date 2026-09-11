import type { createBashToolDefinition as createPiBashTool } from "@earendil-works/pi-coding-agent";
import { sanitizeWorkerSubprocessEnv } from "@leitwerk-dev/process-sdk";

/** Repository commands choose their own mode instead of inheriting the worker service mode. */
export async function createRepositoryBashTool(
	cwd: string,
): Promise<ReturnType<typeof createPiBashTool>> {
	const { createBashToolDefinition } = await import("@earendil-works/pi-coding-agent");
	return createBashToolDefinition(cwd, {
		spawnHook: (context) => ({
			...context,
			env: sanitizeWorkerSubprocessEnv(context.env, { NODE_ENV: undefined }),
		}),
	});
}
