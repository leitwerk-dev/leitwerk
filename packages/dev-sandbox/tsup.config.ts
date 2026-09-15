import { workspaceBuild } from "../../scripts/tsup-config.js";
export default workspaceBuild({
	entry: [
		"src/index.ts",
		"src/launcher.ts",
		"src/storage.ts",
		"src/backend.ts",
		"src/preflight.ts",
	],
	dts: false,
	clean: true,
});
