import { workspaceBuild } from "../../scripts/tsup-config.js";
export default workspaceBuild({
	entry: [
		"src/index.ts",
		"src/config-snapshot.ts",
		"src/http-contracts.ts",
		"src/form-contract.ts",
		"src/launcher-contract.ts",
		"src/protocol.ts",
		"src/tool-renderer-contract.ts",
	],
});
