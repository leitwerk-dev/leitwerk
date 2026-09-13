import { fileURLToPath } from "node:url";
import { launchSandbox } from "@leitwerk-dev/dev-sandbox/launcher";

await launchSandbox({
	publicRoot: fileURLToPath(new URL("../../", import.meta.url)),
	workspaceRoot:
		process.env.LEITWERK_SANDBOX_WORKSPACE_ROOT ??
		fileURLToPath(new URL("../../", import.meta.url)),
	compositionEntry:
		process.env.LEITWERK_SANDBOX_COMPOSITION_ENTRY ??
		fileURLToPath(new URL("../../sandbox/composition.ts", import.meta.url)),
});
