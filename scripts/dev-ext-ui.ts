import type { ChildProcess } from "node:child_process";
import process from "node:process";
import { loadDevContext } from "./dev-context.ts";
import { spawnManaged, stopManagedForExit } from "./dev-process.ts";

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
		await Promise.all(children.map((child) => stopManagedForExit(child, exitCode, 10_000, 1_000)));
		process.exit(exitCode);
	};
	process.once("SIGINT", () => void finish(130));
	process.once("SIGTERM", () => void finish(143));
	for (const child of children) {
		child.once("error", () => void finish(1));
		child.once("exit", (code, signal) => {
			if (!shuttingDown) void finish(code ?? (signal === "SIGINT" ? 130 : 1));
		});
	}
}

void main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
