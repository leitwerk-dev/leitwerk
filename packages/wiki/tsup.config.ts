import { copyFileSync, mkdirSync } from "node:fs";
import { workspaceBuild } from "../../scripts/tsup-config.js";
export default workspaceBuild({
	entry: ["src/index.ts", "src/integration.ts", "src/server/index.ts", "src/ui/index.ts"],
	splitting: true,
	async onSuccess() {
		mkdirSync("dist/ui", { recursive: true });
		for (const file of ["WikiPage.svelte", "WikiEntryEditor.svelte"])
			copyFileSync(`src/ui/${file}`, `dist/ui/${file}`);
	},
});
