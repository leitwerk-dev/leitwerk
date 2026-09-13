import { defineConfig } from "tsup";
export default defineConfig({
	entry: [
		"src/index.ts",
		"src/launcher.ts",
		"src/storage.ts",
		"src/backend.ts",
		"src/preflight.ts",
	],
	format: ["esm"],
	tsconfig: "tsconfig.tsup.json",
	dts: false,
	sourcemap: true,
	clean: true,
});
