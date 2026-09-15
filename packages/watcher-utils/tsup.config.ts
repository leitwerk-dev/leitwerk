import { workspaceBuild } from "../../scripts/tsup-config.js";
export default workspaceBuild({
	entry: [
		"src/index.ts",
		"src/duration-parse.ts",
		"src/poll-loop.ts",
		"src/polling-coordinator.ts",
		"src/process-helpers.ts",
		"src/watcher-coordinator.ts",
	],
});
