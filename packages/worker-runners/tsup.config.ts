import { defineConfig } from "tsup";

export default defineConfig((options) => ({
	entry: [
		"src/index.ts",
		"src/types.ts",
		"src/local-worker-runner.ts",
		"src/docker-worker-runner.ts",
		"src/docker-engine-http-client.ts",
		"src/kubernetes-worker-runner.ts",
		"src/kubernetes-http-client.ts",
	],
	format: ["esm"],
	tsconfig: "tsconfig.tsup.json",
	dts: true,
	clean: !options.watch,
	sourcemap: true,
}));
