import { defineConfig } from "tsup";

export default defineConfig((options) => ({
	entry: [
		"src/index.ts",
		"src/duration-parse.ts",
		"src/poll-loop.ts",
		"src/process-helpers.ts",
		"src/watcher-coordinator.ts",
	],
	format: ["esm"],
	tsconfig: "tsconfig.tsup.json",
	dts: true,
	clean: !options.watch,
	sourcemap: true,
}));
