import type { ExtensionCatalog } from "@leitwerk-dev/extension-runtime";
import { createTestApp as createGenericTestApp } from "@leitwerk-dev/test-support/integration";
import { getDefaultTestExtensionCatalog } from "./test-extension-catalog.js";

export type ExtensionTestResources = Record<string, never>;

export type ExtensionTestApp = Awaited<
	ReturnType<typeof createGenericTestApp<ExtensionTestResources>>
>;

export interface ExtensionTestAppOptions {
	extensionCatalog?: ExtensionCatalog | Promise<ExtensionCatalog>;
	listen?: boolean;
}

export async function createExtensionTestApp(
	opts: ExtensionTestAppOptions = {},
): Promise<ExtensionTestApp> {
	return createGenericTestApp({
		extensionCatalog: opts.extensionCatalog ?? getDefaultTestExtensionCatalog(),
		listen: opts.listen,
	});
}
