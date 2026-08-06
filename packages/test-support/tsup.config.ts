import { defineConfig } from "tsup";

export default defineConfig((options) => ({
	entry: [
		"src/index.ts",
		"src/fakes/index.ts",
		"src/fixtures.ts",
		"src/integration.ts",
		"src/stub-worker-entry.ts",
		"src/worker-testing/index.ts",
	],
	format: ["esm"],
	tsconfig: "tsconfig.tsup.json",
	dts: false,
	clean: !options.watch,
	sourcemap: true,
}));
