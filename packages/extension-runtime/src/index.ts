import {
	setupServerExtensions as setupServerExtensionsImpl,
	setupWorkerExtensions as setupWorkerExtensionsImpl,
} from "./extension-host-setup.js";

export {
	buildExtensionCatalog,
	type CatalogPiContribution,
	type DiscoveredExtensionEntry,
	type DiscoveredPiContribution,
	type ExtensionCatalog,
	importExtensionModules,
	importPiServerAdapter,
	type LoadedExtensionModule,
	loadExtensionCatalog,
	type OwnedModelProviderSet,
	parseResolvedExtensionEntries,
	type ResolveExtensionEntriesOptions,
	RUNTIME_EXTENSION_ALLOWED_ROOTS_ENV,
	RUNTIME_EXTENSION_ENTRIES_ENV,
	resolveExtensionEntries,
	serializeResolvedExtensionEntries,
} from "./extension-loader.js";
export {
	isSourceRuntimeLane,
	LEITWERK_RUNTIME_LANE_ENV,
	type LeitwerkRuntimeLane,
	resolveRuntimeLane,
} from "./runtime-lane.js";
export {
	buildWorkerRuntimeDefinition,
	createCatalogWorkerDefinitionResolver,
	type ResolvedWorkerProcess,
	type RuntimeProcessDefinitionBuildOptions,
} from "./runtime-process-definition.js";

export const setupServerExtensions = setupServerExtensionsImpl;
export const setupWorkerExtensions = setupWorkerExtensionsImpl;
