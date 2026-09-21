import { workspaceBuild } from "../../scripts/tsup-config.js";
export default workspaceBuild({
	entry: [
		"src/index.ts",
		"src/launcher.ts",
		"src/launcher-entry.ts",
		"src/storage.ts",
		"src/storage-entry.ts",
		"src/backend.ts",
		"src/preflight.ts",
	],
	dts: false,
	clean: true,
});
