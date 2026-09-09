import { spawn } from "node:child_process";
import process from "node:process";
import { loadDevContext } from "./dev-context.ts";
import { forwardChildLifecycle } from "./dev-process.ts";

async function main(): Promise<void> {
	const runtimeLane = process.env.LEITWERK_RUNTIME_LANE ?? "source";
	const env: NodeJS.ProcessEnv = {
		...process.env,
		LEITWERK_RUNTIME_LANE: runtimeLane,
	};
	if (runtimeLane === "source" && !env.LEITWERK_DEV_EXTENSION_UI_SOURCES_JSON) {
		const context = await loadDevContext();
		env.LEITWERK_DEV_EXTENSION_UI_SOURCES_JSON = JSON.stringify(
			context.extensions.flatMap((extension) => (extension.uiSource ? [extension.uiSource] : [])),
		);
	}
	const child = spawn("npm", ["run", "dev", "-w", "@leitwerk-dev/ui"], {
		cwd: process.cwd(),
		env,
		stdio: "inherit",
	});

	forwardChildLifecycle(child);
}

void main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
