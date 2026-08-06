import { defineConfig } from "tsup";

export default defineConfig((options) => ({
	entry: {
		"assets/leaf-outcome-element": "src/ui/leaf-outcome-element.ts",
		"assets/poem-leaf-outcome-element": "src/ui/poem-leaf-outcome-element.ts",
	},
	outDir: "dist/ui",
	format: ["esm"],
	tsconfig: "tsconfig.tsup.json",
	dts: false,
	clean: !options.watch,
	silent: true,
	sourcemap: true,
	bundle: true,
	splitting: false,
	platform: "browser",
	target: "es2022",
	noExternal: [/^@leitwerk-dev\/process-sdk/],
	esbuildOptions(buildOptions) {
		buildOptions.conditions = ["source", "browser"];
	},
}));
