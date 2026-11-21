import { fileURLToPath } from "node:url";
import { launchSandbox } from "@leitwerk-dev/dev-sandbox/launcher";
import { selectSandbox } from "@leitwerk-dev/dev-tools/composition";

const option = (name: string) =>
	process.argv
		.slice(2)
		.find((arg) => arg.startsWith(`--${name}=`))
		?.slice(name.length + 3);
const manifest = option("composition");
const args = process.argv.slice(2).filter((arg) => !arg.startsWith("--composition="));
if (!manifest && option("sandbox") !== undefined)
	throw new Error("--sandbox requires --composition");
await launchSandbox({
	publicRoot: fileURLToPath(new URL("../../", import.meta.url)),
	...(manifest
		? selectSandbox(manifest, args)
		: {
				args,
				workspaceRoot:
					process.env.LEITWERK_SANDBOX_WORKSPACE_ROOT ??
					fileURLToPath(new URL("../../", import.meta.url)),
				compositionEntry:
					process.env.LEITWERK_SANDBOX_COMPOSITION_ENTRY ??
					fileURLToPath(new URL("../../sandbox/composition.ts", import.meta.url)),
			}),
});
