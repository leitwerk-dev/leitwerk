import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { assertSelection, compositionPath, type DevelopmentOptions } from "./selection.js";

/**
 * Run the selected checkout's sandbox launcher in the foreground process group. The
 * launcher owns signal handling and supervisor cleanup; this process only waits.
 * @internal
 */
export async function runSandbox(options: DevelopmentOptions, args: string[]): Promise<void> {
	const selection = assertSelection(options);
	if (selection.mode !== "local" || !selection.checkout)
		throw new Error("The sandbox requires the local core. Run core:use-local first.");
	const child = spawn(
		process.execPath,
		[
			"--conditions=source",
			"--import",
			"tsx",
			path.join(selection.checkout, "scripts/sandbox/cli.ts"),
			`--composition=${compositionPath(options)}`,
			...args,
		],
		{ cwd: selection.checkout, stdio: "inherit" },
	);
	const ignore = () => {};
	process.on("SIGINT", ignore);
	process.on("SIGTERM", ignore);
	try {
		const [code, signal] = await once(child, "exit");
		if (code !== 0) throw new Error(`Sandbox stopped (${signal ?? code})`);
	} finally {
		process.off("SIGINT", ignore);
		process.off("SIGTERM", ignore);
	}
}
