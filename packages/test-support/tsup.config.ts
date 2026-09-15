import { workspaceBuild } from "../../scripts/tsup-config.js";
export default workspaceBuild({
	entry: [
		"src/index.ts",
		"src/local-git.ts",
		"src/fakes/index.ts",
		"src/fixtures.ts",
		"src/integration.ts",
		"src/stub-worker-entry.ts",
		"src/worker-testing/index.ts",
	],
	dts: false,
});
