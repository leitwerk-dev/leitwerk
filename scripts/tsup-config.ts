import type { Options } from "tsup";

/** Defaults for packages built from this checkout; each workspace owns its entry points. */
export function workspaceBuild(overrides: Options = {}) {
	return (options: Options): Options => ({
		entry: ["src/index.ts"],
		format: ["esm"],
		tsconfig: "tsconfig.tsup.json",
		dts: true,
		clean: !options.watch,
		sourcemap: true,
		...overrides,
	});
}

/** Browser defaults for extension custom elements. @internal */
export function extensionUiBuild(entry: Options["entry"]) {
	return workspaceBuild({
		entry,
		outDir: "dist/ui",
		dts: false,
		silent: true,
		bundle: true,
		splitting: false,
		platform: "browser",
		target: "es2022",
		noExternal: [/^@leitwerk-dev\/process-sdk/],
		esbuildOptions(buildOptions) {
			buildOptions.conditions = ["source", "browser"];
		},
	});
}
