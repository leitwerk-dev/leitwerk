import { coreHostCapabilities, type LeitwerkExtensionModule } from "@leitwerk-dev/process-sdk";
import { type WoodpeckerIntegration, woodpeckerIntegration } from "./capability.js";
import { parseWoodpeckerProfiles, WoodpeckerClient } from "./client.js";
import { createWoodpeckerProvider } from "./provider.js";
import { registerWoodpeckerTools } from "./tools.js";

/** @internal */
const manifest = {
	/** @internal */
	id: "woodpecker",
	/** @internal */
	version: "0.1.9",
} as const;
/** @public */
const extension: LeitwerkExtensionModule = {
	manifest,
	setupServer(api, config) {
		const profiles = parseWoodpeckerProfiles(config);
		const integration: WoodpeckerIntegration = {
			client(profile) {
				const value = profiles.get(profile);
				if (!value) throw new Error(`Unknown Woodpecker profile '${profile}'`);
				return new WoodpeckerClient(value);
			},
		};
		setupWoodpeckerIntegration(api, integration);
	},
};

export type { WoodpeckerIntegration } from "./capability.js";
export { woodpeckerIntegration } from "./capability.js";
export type { WoodpeckerPipeline } from "./client.js";
export { WOODPECKER_PIPELINE_KIND, woodpeckerExternal } from "./external.js";
export default extension;

/** Register shared tools and polling with an explicit integration. @public */
export function setupWoodpeckerIntegration(
	api: Parameters<NonNullable<LeitwerkExtensionModule["setupServer"]>>[0],
	integration: WoodpeckerIntegration,
	options: {
		/** @public */
		now?: () => number;
	} = {},
) {
	api.provide(woodpeckerIntegration, integration);
	const deps = api.get(coreHostCapabilities.serverSetup);
	if (!deps || Array.isArray(deps)) return;
	registerWoodpeckerTools(api, integration);
	return createWoodpeckerProvider(deps, integration, options);
}

export * from "./binding.js";
