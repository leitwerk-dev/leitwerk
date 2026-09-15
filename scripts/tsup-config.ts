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
