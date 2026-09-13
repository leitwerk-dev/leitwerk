import { defineConfig } from "tsup";
export default defineConfig({
	entry: ["src/index.ts", "src/testing.ts"],
	format: ["esm"],
	tsconfig: "tsconfig.tsup.json",
	dts: false,
	sourcemap: true,
	clean: true,
});
