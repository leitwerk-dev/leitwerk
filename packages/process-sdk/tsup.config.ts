import { workspaceBuild } from "../../scripts/tsup-config.js";
export default workspaceBuild({
	entry: [
		"src/index.ts",
		"src/git-binary.ts",
		"src/leaf-outcome-renderer.ts",
		"src/pi-config.ts",
		"src/review-flow.ts",
		"src/runtime-internals.ts",
	],
});
