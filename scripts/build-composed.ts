import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { activateDevelopmentComposition, type ComposedPackage } from "./development-composition.ts";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command: string, args: string[], cwd = process.cwd()): void {
	const result = spawnSync(command, args, { cwd, env: process.env, stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}

function hasScript(packageInfo: ComposedPackage, name: string): boolean {
	const scripts = packageInfo.packageJson.scripts;
	return (
		typeof scripts === "object" &&
		scripts !== null &&
		typeof (scripts as Record<string, unknown>)[name] === "string"
	);
}

function orderedPackages(packages: readonly ComposedPackage[]): ComposedPackage[] {
	const byName = new Map(packages.map((entry) => [entry.name, entry]));
	const result: ComposedPackage[] = [];
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (entry: ComposedPackage): void => {
		if (visited.has(entry.name)) return;
		if (visiting.has(entry.name))
			throw new Error(`Circular composed package dependency at '${entry.name}'`);
		visiting.add(entry.name);
		for (const field of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
			const dependencies = entry.packageJson[field];
			if (typeof dependencies !== "object" || dependencies === null) continue;
			for (const name of Object.keys(dependencies)) {
				const dependency = byName.get(name);
				if (dependency) visit(dependency);
			}
		}
		visiting.delete(entry.name);
		visited.add(entry.name);
		result.push(entry);
	};
	for (const entry of packages) visit(entry);
	return result;
}

const mode = process.argv.includes("--ext-ui") ? "build:ext-ui" : "build";
const composition = activateDevelopmentComposition(process.cwd());
if (mode === "build") {
	run(process.execPath, [
		"scripts/run-quiet.mjs",
		"npx",
		"turbo",
		"run",
		"build",
		"--output-logs=errors-only",
	]);
	run(npm, ["run", "--silent", "stage:licenses"]);
} else {
	run(process.execPath, [
		"scripts/run-quiet.mjs",
		"npx",
		"turbo",
		"run",
		"build:ext-ui",
		"--output-logs=errors-only",
	]);
}
for (const packageInfo of orderedPackages(composition?.externalPackages ?? [])) {
	if (!hasScript(packageInfo, mode)) continue;
	console.info(`[composition] ${mode} ${packageInfo.name}`);
	run(npm, ["run", mode, "--prefix", packageInfo.dir]);
}
if (mode === "build") {
	for (const extensionDir of composition?.extensionDirs ?? []) {
		const packageInfo = composition.externalPackages.find(
			(entry) => entry.dir === path.resolve(extensionDir),
		);
		if (packageInfo && !hasScript(packageInfo, "build")) {
			throw new Error(`Composed extension '${packageInfo.name}' must declare a build script`);
		}
	}
}
