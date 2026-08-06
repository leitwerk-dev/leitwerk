import codingExtension from "@leitwerk-dev/coding";
import type { ExtensionCatalog } from "@leitwerk-dev/extension-runtime";
import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import gitSshExtension from "@leitwerk-dev/git-ssh";
import remoteRepoChangeExtension from "@leitwerk-dev/remote-repo-change";
import showcaseProcessesExtension from "@leitwerk-dev/showcase-processes";

let cachedCatalog: ExtensionCatalog | null = null;

export async function getDefaultTestExtensionCatalog(): Promise<ExtensionCatalog> {
	if (!cachedCatalog) {
		cachedCatalog = await buildExtensionCatalogFromModules([
			codingExtension,
			gitSshExtension,
			remoteRepoChangeExtension,
			showcaseProcessesExtension,
		]);
	}
	return cachedCatalog;
}
