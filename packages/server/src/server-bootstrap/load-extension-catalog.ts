import {
	type DiscoveredExtensionEntry,
	type ExtensionCatalog,
	loadExtensionCatalog,
	resolveExtensionEntries,
} from "@leitwerk-dev/extension-runtime";
import type { LeitwerkConfig } from "../config/index.js";

export async function loadServerExtensionCatalog(input: {
	config: LeitwerkConfig;
	extensionCatalog?: ExtensionCatalog | Promise<ExtensionCatalog>;
	resolvedExtensionEntries?: readonly DiscoveredExtensionEntry[];
	extensionLoadingStartDir?: string;
}): Promise<{
	extensionLoadingStartDir: string;
	resolvedExtensionEntries: DiscoveredExtensionEntry[];
	extensionCatalog: ExtensionCatalog;
}> {
	const extensionLoadingStartDir = input.extensionLoadingStartDir ?? process.cwd();
	const resolvedExtensionEntries = input.resolvedExtensionEntries
		? [...input.resolvedExtensionEntries]
		: await resolveExtensionEntries({
				startDir: extensionLoadingStartDir,
				sources: input.config.extension_loading.sources,
			});
	const extensionCatalog = await Promise.resolve(
		input.extensionCatalog ??
			loadExtensionCatalog({
				startDir: extensionLoadingStartDir,
				sources: input.config.extension_loading.sources,
			}),
	);
	return { extensionLoadingStartDir, resolvedExtensionEntries, extensionCatalog };
}
