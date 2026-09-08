import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/index.ts"],
	format: ["esm"],
	tsconfig: "tsconfig.tsup.json",
	dts: true,
	sourcemap: true,
	clean: true,
	target: "node26",
});
