import { defineConfig } from "tsup";

export default defineConfig((options) => ({
	entry: [
		"src/index.ts",
		"src/git-binary.ts",
		"src/leaf-outcome-renderer.ts",
		"src/pi-config.ts",
		"src/review-flow.ts",
		"src/runtime-internals.ts",
	],
	format: ["esm"],
	tsconfig: "tsconfig.tsup.json",
	dts: true,
	clean: !options.watch,
	sourcemap: true,
}));
