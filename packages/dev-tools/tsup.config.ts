import { workspaceBuild } from "../../scripts/tsup-config.js";
export default workspaceBuild({
	entry: [
		"src/index.ts",
		"src/cli.ts",
		"src/skill-pack.ts",
		"src/benchmark.ts",
		"src/server.ts",
		"src/supervisor.ts",
		"src/composition.ts",
		"src/workspace.ts",
		"src/bundle.ts",
		"src/bundle-check.ts",
	],
	dts: false,
	splitting: true,
});
