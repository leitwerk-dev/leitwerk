import { fileURLToPath } from "node:url";
import { launchSandbox } from "@leitwerk-dev/dev-sandbox/launcher";
import { loadWorkspaceComposition } from "@leitwerk-dev/dev-tools/composition";

const option = (name: string) =>
	process.argv
		.slice(2)
		.find((arg) => arg.startsWith(`--${name}=`))
		?.slice(name.length + 3);
const manifest = option("composition");
const selected = option("sandbox");
const args = process.argv
	.slice(2)
	.filter((arg) => !arg.startsWith("--composition=") && !arg.startsWith("--sandbox="));

function fromManifest(file: string) {
	const composition = loadWorkspaceComposition(file);
	const names = Object.keys(composition.sandboxes);
	const name = selected ?? (names.length === 1 ? names[0] : undefined);
	if (!name || !composition.sandboxes[name])
		throw new Error(
			names.length
				? `Select a sandbox with --sandbox=<name>: ${names.join(", ")}`
				: `${file} declares no sandboxes`,
		);
	return {
		workspaceRoot: composition.workspaceRoot,
		compositionEntry: composition.sandboxes[name],
	};
}

if (selected && !manifest) throw new Error("--sandbox requires --composition");
await launchSandbox({
	publicRoot: fileURLToPath(new URL("../../", import.meta.url)),
	...(manifest
		? fromManifest(manifest)
		: {
				workspaceRoot:
					process.env.LEITWERK_SANDBOX_WORKSPACE_ROOT ??
					fileURLToPath(new URL("../../", import.meta.url)),
				compositionEntry:
					process.env.LEITWERK_SANDBOX_COMPOSITION_ENTRY ??
					fileURLToPath(new URL("../../sandbox/composition.ts", import.meta.url)),
			}),
	args,
});
