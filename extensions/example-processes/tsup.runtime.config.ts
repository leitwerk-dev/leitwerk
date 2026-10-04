import { defineConfig } from "tsup";

export default defineConfig((options) => ({
	entry: ["src/index.ts"],
	format: ["esm"],
	bundle: true,
	tsconfig: "tsconfig.tsup.json",
	dts: true,
	clean: !options.watch,
	silent: true,
	sourcemap: true,
}));
