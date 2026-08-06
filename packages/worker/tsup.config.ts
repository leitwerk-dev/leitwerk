import { defineConfig } from "tsup";

export default defineConfig((options) => ({
	entry: ["src/index.ts", "src/worker-entry.ts"],
	format: ["esm"],
	tsconfig: "tsconfig.tsup.json",
	dts: true,
	clean: !options.watch,
	sourcemap: true,
}));
