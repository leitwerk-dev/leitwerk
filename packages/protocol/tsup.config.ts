import { defineConfig } from "tsup";

export default defineConfig((options) => ({
	entry: [
		"src/index.ts",
		"src/config-snapshot.ts",
		"src/http-contracts.ts",
		"src/form-contract.ts",
		"src/launcher-contract.ts",
		"src/tool-renderer-contract.ts",
	],
	format: ["esm"],
	tsconfig: "tsconfig.tsup.json",
	dts: true,
	clean: !options.watch,
	sourcemap: true,
}));
