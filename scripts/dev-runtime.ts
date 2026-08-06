import { type ChildProcess, spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

interface RootPackageJson {
	workspaces?: unknown;
}

interface WorkspacePackageJson {
	name?: unknown;
	scripts?: unknown;
}

interface RuntimeBuildTask {
	workspaceName: string;
	scriptName: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function listWorkspacePatterns(workspaces: unknown): string[] {
	if (Array.isArray(workspaces)) {
		return workspaces.filter((value): value is string => typeof value === "string");
	}
	if (isRecord(workspaces) && Array.isArray(workspaces.packages)) {
		return workspaces.packages.filter((value): value is string => typeof value === "string");
	}
	return [];
}

function stringScript(scripts: unknown, scriptName: string): string | null {
	if (!isRecord(scripts)) {
		return null;
	}
	const script = scripts[scriptName];
	return typeof script === "string" ? script : null;
}

function selectRuntimeBuildScript(packageJson: WorkspacePackageJson): string | null {
	if (
		packageJson.name === "@leitwerk-dev/ui" ||
		packageJson.name === "@leitwerk-dev/test-support"
	) {
		return null;
	}
	if (stringScript(packageJson.scripts, "build:runtime")) {
		return "build:runtime";
	}
	const buildScript = stringScript(packageJson.scripts, "build");
	return buildScript?.includes("tsup") ? "build" : null;
}

async function listRuntimeBuildTasks(workspaceRoot: string): Promise<RuntimeBuildTask[]> {
	const rootPackageJson = JSON.parse(
		await readFile(path.join(workspaceRoot, "package.json"), "utf8"),
	) as RootPackageJson;
	const tasks = new Map<string, RuntimeBuildTask>();

	for (const pattern of listWorkspacePatterns(rootPackageJson.workspaces)) {
		if (!pattern.endsWith("/*")) {
			continue;
		}
		const baseDir = path.join(workspaceRoot, pattern.slice(0, -2));
		const dirents = await readdir(baseDir, { withFileTypes: true }).catch(() => []);
		for (const dirent of dirents) {
			if (!dirent.isDirectory()) {
				continue;
			}
			const packageJsonRaw = await readFile(
				path.join(baseDir, dirent.name, "package.json"),
				"utf8",
			).catch((error: unknown) => {
				if (
					typeof error === "object" &&
					error !== null &&
					"code" in error &&
					error.code === "ENOENT"
				) {
					return null;
				}
				throw error;
			});
			if (!packageJsonRaw) {
				continue;
			}
			const packageJson = JSON.parse(packageJsonRaw) as WorkspacePackageJson;
			const scriptName = selectRuntimeBuildScript(packageJson);
			if (typeof packageJson.name === "string" && scriptName) {
				tasks.set(packageJson.name, { workspaceName: packageJson.name, scriptName });
			}
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
	const tasks = await listRuntimeBuildTasks(process.cwd());
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
			["run", task.scriptName, "-w", task.workspaceName, "--", "--watch", "--no-dts"],
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
