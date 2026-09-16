import { type ChildProcess, spawn } from "node:child_process";
import process from "node:process";
import { loadActiveDevelopmentComposition } from "./development-composition.ts";
import { type WorkspacePackage, workspacePackages } from "./workspace-packages.ts";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

interface RuntimeBuildTask {
	workspaceName: string;
	scriptName: string;
	packageDir?: string;
}

function selectRuntimeBuildScript(packageJson: WorkspacePackage): string | null {
	if (
		packageJson.name === "@leitwerk-dev/ui" ||
		packageJson.name === "@leitwerk-dev/test-support"
	) {
		return null;
	}
	if (
		typeof packageJson.scripts?.["build:runtime"] === "string" &&
		packageJson.scripts["build:runtime"]
	) {
		return "build:runtime";
	}
	const buildScript = packageJson.scripts?.build;
	return typeof buildScript === "string" && buildScript.includes("tsup") ? "build" : null;
}

function listRuntimeBuildTasks(workspaceRoot: string): RuntimeBuildTask[] {
	const tasks = new Map<string, RuntimeBuildTask>();
	for (const packageJson of workspacePackages(workspaceRoot)) {
		const scriptName = selectRuntimeBuildScript(packageJson);
		if (scriptName) {
			tasks.set(packageJson.name, { workspaceName: packageJson.name, scriptName });
		}
	}
	return [...tasks.values()].sort((left, right) =>
		left.workspaceName.localeCompare(right.workspaceName),
	);
}

function spawnNpm(args: string[], env: NodeJS.ProcessEnv): ChildProcess {
	return spawn(npmCommand, args, {
		cwd: process.cwd(),
		env,
		stdio: "inherit",
	});
}

async function main(): Promise<void> {
	const tasks = listRuntimeBuildTasks(process.cwd());
	for (const entry of loadActiveDevelopmentComposition(process.cwd())?.externalPackages ?? []) {
		const scriptName = selectRuntimeBuildScript(entry);
		if (scriptName) tasks.push({ workspaceName: entry.name, scriptName, packageDir: entry.dir });
	}
	tasks.sort((left, right) => left.workspaceName.localeCompare(right.workspaceName));
	if (tasks.length === 0) {
		console.info("[dev:runtime] No runtime build watch tasks found.");
		return;
	}

	console.info(
		`[dev:runtime] Watching runtime builds (declarations skipped via --no-dts): ${tasks
			.map((task) => `${task.workspaceName}:${task.scriptName}`)
			.join(", ")}`,
	);
	// Append `--no-dts` so the live watch rebuilds skip TypeScript declaration
	// emission. Declarations are the most CPU-heavy part of each tsup rebuild and
	// the running server never imports them, so skipping them sharply reduces the
	// build-storm contention that slows dev startup and live reloads. The one-time
	// turbo prebuild and production builds still emit declarations (they do not go
	// through this watch lane).
	const children = tasks.map((task) =>
		spawnNpm(
			task.packageDir
				? ["run", task.scriptName, "--prefix", task.packageDir, "--", "--watch", "--no-dts"]
				: ["run", task.scriptName, "-w", task.workspaceName, "--", "--watch", "--no-dts"],
			process.env,
		),
	);
	let shuttingDown = false;

	const finish = (exitCode: number) => {
		if (shuttingDown) {
			return;
		}
		shuttingDown = true;
		for (const child of children) {
			if (child.exitCode === null && child.signalCode === null) {
				child.kill("SIGTERM");
			}
		}
		process.exit(exitCode);
	};

	process.once("SIGINT", () => finish(130));
	process.once("SIGTERM", () => finish(143));

	for (const child of children) {
		child.once("error", () => finish(1));
		child.once("exit", (code, signal) => {
			if (shuttingDown) {
				return;
			}
			finish(code ?? (signal === "SIGINT" ? 130 : 1));
		});
	}
}

void main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
