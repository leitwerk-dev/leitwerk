import type { ChildProcess } from "node:child_process";
import process from "node:process";
import { loadDevContext } from "./dev-context.ts";
import { exitStopOptions, spawnManaged, stopManaged, watchChildren } from "./dev-process.ts";

async function main(): Promise<void> {
	const context = await loadDevContext();
	const targets = context.extensions.filter(
		(extension) => typeof extension.packageJson.scripts?.["dev:ext-ui"] === "string",
	);
	if (targets.length === 0) {
		console.info("[dev:ext-ui] No active extension UI watch tasks found.");
		return;
	}

	console.info(
		`[dev:ext-ui] Watching active extension UI assets: ${targets.map((x) => x.packageName).join(", ")}`,
	);
	const children: ChildProcess[] = targets.map((target) =>
		spawnManaged("npm", ["run", "dev:ext-ui", "--prefix", target.packageDir], {
			cwd: process.cwd(),
			env: { ...process.env, LEITWERK_RUNTIME_LANE: "source" },
			stdio: "inherit",
		}),
	);
	let shuttingDown = false;
	const finish = async (exitCode: number): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		const options = exitStopOptions(exitCode, 10_000, 1_000);
		await Promise.all(children.map((child) => stopManaged(child, options)));
		process.exit(exitCode);
	};
	watchChildren(children, finish);
}

void main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
