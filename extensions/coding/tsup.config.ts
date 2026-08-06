import { defineConfig } from "tsup";
export default defineConfig({
	entry: [
		"src/index.ts",
		"src/auto-work-branch.ts",
		"src/finalization-git.ts",
		"src/repository-change-launch.ts",
		"src/repository-change-state.ts",
		"src/turns/*.ts",
	],
	format: ["esm"],
	dts: true,
	clean: true,
	sourcemap: true,
	tsconfig: "tsconfig.tsup.json",
});
