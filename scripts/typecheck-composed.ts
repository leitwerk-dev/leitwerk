import process from "node:process";
import {
	activateDevelopmentComposition,
	externalPackageProjects,
} from "./development-composition.ts";
import { runCommand } from "./run-command.ts";

const composition = activateDevelopmentComposition(process.cwd());
const projects = composition ? externalPackageProjects(composition) : [];
runCommand("npx", ["tsc", "-b", "--force", "--emitDeclarationOnly", "tsconfig.json", ...projects]);
runCommand(process.execPath, ["--import", "tsx", "scripts/preserve-api-annotations.ts"]);
process.exit(0);
