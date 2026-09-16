import { workspaceBuild } from "../../scripts/tsup-config.js";
export default workspaceBuild({
	entry: [
		"src/index.ts",
		"src/cli.ts",
		"src/benchmark.ts",
		"src/server.ts",
		"src/composition.ts",
		"src/workspace.ts",
	],
	dts: false,
	splitting: true,
});
