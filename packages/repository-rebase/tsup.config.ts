import { workspaceBuild } from "../../scripts/tsup-config.js";
export default workspaceBuild({
	entry: ["src/index.ts", "src/git.ts", "src/git-public.ts", "src/prompt.ts"],
	dts: false,
	clean: true,
});
