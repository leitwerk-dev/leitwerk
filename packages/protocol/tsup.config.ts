import { workspaceBuild } from "../../scripts/tsup-config.js";
export default workspaceBuild({
	entry: [
		"src/index.ts",
		"src/config-snapshot.ts",
		"src/config-snapshot-public.ts",
		"src/http-contracts.ts",
		"src/http-contracts-public.ts",
		"src/form-contract.ts",
		"src/form-contract-public.ts",
		"src/launcher-contract.ts",
		"src/launcher-contract-public.ts",
		"src/protocol.ts",
		"src/tool-renderer-contract.ts",
		"src/tool-renderer-contract-public.ts",
	],
});
