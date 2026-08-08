import { spawnSync } from "node:child_process";
import process from "node:process";
import { activateDevelopmentComposition } from "./development-composition.ts";

const composition = activateDevelopmentComposition(process.cwd());
const write = process.argv.includes("--write");
const args = [write ? "check" : "ci", ...(write ? ["--write"] : ["--reporter=github"]), "."];
for (const packageInfo of composition?.externalPackages ?? []) args.push(packageInfo.dir);
for (const testRoot of composition?.testRoots ?? []) args.push(testRoot);
const result = spawnSync("npx", ["biome", ...args], {
	cwd: process.cwd(),
	env: process.env,
	stdio: "inherit",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
