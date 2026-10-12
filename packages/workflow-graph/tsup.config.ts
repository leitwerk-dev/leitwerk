import { copyFileSync } from "node:fs";
import { workspaceBuild } from "../../scripts/tsup-config.js";
export default workspaceBuild({
	async onSuccess() {
		for (const file of ["WorkflowGraph.svelte", "WorkflowIcon.svelte", "WorkflowRoute.svelte"])
			copyFileSync(`src/${file}`, `dist/${file}`);
	},
});
