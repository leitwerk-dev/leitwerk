import process from "node:process";
import { activateDevelopmentComposition } from "./development-composition.ts";
import { runCommand } from "./run-command.ts";

const composition = activateDevelopmentComposition(process.cwd());
const write = process.argv.includes("--write");
const args = [write ? "check" : "ci", ...(write ? ["--write"] : ["--reporter=github"]), "."];
for (const packageInfo of composition?.externalPackages ?? []) args.push(packageInfo.dir);
for (const testRoot of composition?.testRoots ?? []) args.push(testRoot);
runCommand("npx", ["biome", ...args]);
process.exit(0);
