import { workspaceBuild } from "../../scripts/tsup-config.js";
export default workspaceBuild({
	entry: [
		"src/index.ts",
		"src/repository-rebase/index.ts",
		"src/auto-work-branch.ts",
		"src/finalization-git.ts",
		"src/repository-change-launch.ts",
		"src/repository-change-state.ts",
		"src/repository-change-publication.ts",
		"src/turns/*.ts",
	],
	clean: true,
});
