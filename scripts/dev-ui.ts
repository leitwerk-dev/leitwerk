import { spawn } from "node:child_process";
import process from "node:process";
import { loadDevContext } from "./dev-context.ts";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

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
	const child = spawn(npmCommand, ["run", "dev", "-w", "@leitwerk-dev/ui"], {
		cwd: process.cwd(),
		env,
		stdio: "inherit",
	});

	process.once("SIGINT", () => child.kill("SIGINT"));
	process.once("SIGTERM", () => child.kill("SIGTERM"));
	child.once("error", (error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	});
	child.once("exit", (code, signal) => {
		if (signal === "SIGINT") {
			process.exit(130);
			return;
		}
		if (signal === "SIGTERM") {
			process.exit(143);
			return;
		}
		process.exit(code ?? 1);
	});
}

void main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
