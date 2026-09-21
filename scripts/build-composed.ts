import path from "node:path";
import process from "node:process";
import { orderedPackages } from "../packages/dev-tools/src/workspace.ts";
import { activateDevelopmentComposition } from "./development-composition.ts";
import { runCommand } from "./run-command.ts";

const toolingEnvironment = {
	...process.env,
	DO_NOT_TRACK: "1",
	SCARF_ANALYTICS: "false",
	TURBO_DISABLE_UPDATE_CHECK: "1",
	TURBO_TELEMETRY_DISABLED: "1",
};

function run(command: string, args: string[], cwd = process.cwd()): void {
	runCommand(command, args, { cwd, env: toolingEnvironment });
}

const mode = process.argv.includes("--ext-ui") ? "build:ext-ui" : "build";
const composition = activateDevelopmentComposition(process.cwd());
run(process.execPath, [
	"scripts/run-quiet.mjs",
	"npx",
	"turbo",
	"run",
	mode,
	"--output-logs=errors-only",
]);
if (mode === "build") {
	run(process.execPath, ["--import", "tsx", "scripts/preserve-api-annotations.ts"]);
	run("npm", ["run", "--silent", "stage:licenses"]);
}
const packages = orderedPackages(composition?.externalPackages ?? [], (entry) =>
	Object.keys({ ...entry.dependencies, ...entry.devDependencies, ...entry.optionalDependencies }),
);
for (const packageInfo of packages) {
	if (typeof packageInfo.scripts?.[mode] !== "string") continue;
	console.info(`[composition] ${mode} ${packageInfo.name}`);
	run("npm", ["run", mode, "--prefix", packageInfo.dir]);
}
if (mode === "build") {
	for (const extensionDir of composition?.extensionDirs ?? []) {
		const packageInfo = composition.externalPackages.find(
			(entry) => entry.dir === path.resolve(extensionDir),
		);
		if (packageInfo && typeof packageInfo.scripts?.build !== "string") {
			throw new Error(`Composed extension '${packageInfo.name}' must declare a build script`);
		}
	}
}
