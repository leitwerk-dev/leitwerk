import { spawn } from "node:child_process";
import process from "node:process";
import { watchChildren } from "./dev-process.ts";
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

function runtimeBuildTasks(packages: WorkspacePackage[], external = false): RuntimeBuildTask[] {
	return packages.flatMap((entry) => {
		const scriptName = selectRuntimeBuildScript(entry);
		return scriptName
			? [{ workspaceName: entry.name, scriptName, ...(external ? { packageDir: entry.dir } : {}) }]
			: [];
	});
}

async function main(): Promise<void> {
	const core = runtimeBuildTasks(workspacePackages(process.cwd()));
	const tasks = [
		...new Map(core.map((task) => [task.workspaceName, task])).values(),
		...runtimeBuildTasks(
			loadActiveDevelopmentComposition(process.cwd())?.externalPackages ?? [],
			true,
		),
	].sort((left, right) => left.workspaceName.localeCompare(right.workspaceName));
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
		spawn(
			npmCommand,
			task.packageDir
				? ["run", task.scriptName, "--prefix", task.packageDir, "--", "--watch", "--no-dts"]
				: ["run", task.scriptName, "-w", task.workspaceName, "--", "--watch", "--no-dts"],
			{ cwd: process.cwd(), env: process.env, stdio: "inherit" },
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

	watchChildren(children, finish);
}

void main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
