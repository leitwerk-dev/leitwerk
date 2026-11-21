import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchSandbox } from "@leitwerk-dev/dev-sandbox/launcher";
import { loadWorkspaceComposition } from "./composition.js";
import { assertSelection, compositionPath, type DevelopmentOptions } from "./selection.js";

/**
 * Run the selected checkout's sandbox launcher in the foreground process group. The
 * launcher owns signal handling and supervisor cleanup; this process only waits.
 * @internal
 */
export async function runSandbox(options: DevelopmentOptions, args: string[]): Promise<void> {
	const selection = assertSelection(options);
	const manifest = compositionPath(options);
	const composition = loadWorkspaceComposition(manifest);
	const selected = args.find((arg) => arg.startsWith("--sandbox="))?.slice("--sandbox=".length);
	const names = Object.keys(composition.sandboxes);
	const name = selected ?? (names.length === 1 ? names[0] : undefined);
	if (!name || !composition.sandboxes[name])
		throw new Error(
			names.length
				? `Select a sandbox with --sandbox=<name>: ${names.join(", ")}`
				: `${manifest} declares no sandboxes`,
		);
	const launcherArgs = args.filter((arg) => !arg.startsWith("--sandbox="));
	if (selection.mode !== "local") {
		const supervisorEntry = fileURLToPath(
			await import.meta.resolve("@leitwerk-dev/dev-tools/supervisor"),
		);
		await launchSandbox({
			workspaceRoot: composition.workspaceRoot,
			compositionEntry: composition.sandboxes[name],
			supervisorEntry,
			args: launcherArgs,
		});
		return;
	}
	if (!selection.checkout) throw new Error("Local core selection has no checkout");
	const child = spawn(
		process.execPath,
		[
			"--conditions=source",
			"--import",
			path.join(selection.checkout, "scripts/pi-source-conditions.mjs"),
			"--import",
			"tsx",
			path.join(selection.checkout, "scripts/sandbox/cli.ts"),
			`--composition=${manifest}`,
			`--sandbox=${name}`,
			...launcherArgs,
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
