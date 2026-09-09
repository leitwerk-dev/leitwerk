import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { forwardChildLifecycle } from "./dev-process.ts";

function stripSourceCondition(nodeOptions: string | undefined): string | undefined {
	if (!nodeOptions) {
		return undefined;
	}
	const filtered = nodeOptions
		.split(/\s+/u)
		.filter((token) => token.length > 0 && token !== "--conditions=source");
	return filtered.length > 0 ? filtered.join(" ") : undefined;
}

async function main(): Promise<void> {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		LEITWERK_RUNTIME_LANE: "dist",
	};
	delete env.LEITWERK_LOCAL_WORKER_COMMAND;
	delete env.LEITWERK_LOCAL_WORKER_ARGS_JSON;
	const sanitizedNodeOptions = stripSourceCondition(env.NODE_OPTIONS);
	if (sanitizedNodeOptions) {
		env.NODE_OPTIONS = sanitizedNodeOptions;
	} else {
		delete env.NODE_OPTIONS;
	}

	const child = spawn(
		process.execPath,
		[path.join(process.cwd(), "packages/server/dist/main.js")],
		{
			cwd: process.cwd(),
			env,
			stdio: "inherit",
		},
	);

	forwardChildLifecycle(child);
}

void main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
