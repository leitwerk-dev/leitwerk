import { workspaceBuild } from "../../scripts/tsup-config.js";
export default workspaceBuild({
	entry: [
		"src/index.ts",
		"src/types-public.ts",
		"src/types.ts",
		"src/local-public.ts",
		"src/local-worker-runner.ts",
		"src/docker-public.ts",
		"src/docker-worker-runner.ts",
		"src/docker-client-public.ts",
		"src/docker-engine-http-client.ts",
		"src/kubernetes-public.ts",
		"src/kubernetes-worker-runner.ts",
		"src/kubernetes-client-public.ts",
		"src/kubernetes-http-client.ts",
		"src/session-transfer-helper.ts",
		"src/session-transfer-helper-cli.ts",
	],
});
