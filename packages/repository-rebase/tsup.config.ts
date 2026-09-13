import { defineConfig } from "tsup";
export default defineConfig({
	entry: ["src/index.ts", "src/git.ts", "src/prompt.ts"],
	format: ["esm"],
	tsconfig: "tsconfig.tsup.json",
	dts: false,
	sourcemap: true,
	clean: true,
});
