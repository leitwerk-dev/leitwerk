import { spawnSync } from "node:child_process";
import process from "node:process";
import {
	activateDevelopmentComposition,
	externalPackageProjects,
} from "./development-composition.ts";

const composition = activateDevelopmentComposition(process.cwd());
const projects = composition ? externalPackageProjects(composition) : [];
const result = spawnSync("npx", ["tsc", "-b", "--force", "tsconfig.json", ...projects], {
	cwd: process.cwd(),
	env: process.env,
	stdio: "inherit",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
