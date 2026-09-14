import type { ExternalWriteLogRepoLike } from "@leitwerk-dev/external-writes";
import { coreHostCapabilities, type LeitwerkExtensionModule } from "@leitwerk-dev/process-sdk";
import { type WoodpeckerIntegration, woodpeckerIntegration } from "./capability.js";
import { parseWoodpeckerProfiles, WoodpeckerClient } from "./client.js";
import { createWoodpeckerProvider } from "./provider.js";
import { registerWoodpeckerTools } from "./tools.js";
export const manifest = { id: "woodpecker", version: "0.1.9" } as const;
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

export * from "./capability.js";
export * from "./client.js";
export * from "./external.js";
export default extension;

/** Register shared tools and polling with an explicit integration. */
export function setupWoodpeckerIntegration(
	api: Parameters<NonNullable<LeitwerkExtensionModule["setupServer"]>>[0],
	integration: WoodpeckerIntegration,
	options: { now?: () => number } = {},
) {
	api.provide(woodpeckerIntegration, integration);
	const deps = api.get(coreHostCapabilities.serverSetup);
	if (!deps || Array.isArray(deps)) return;
	registerWoodpeckerTools(api, integration, deps.externalWrites as ExternalWriteLogRepoLike);
	return createWoodpeckerProvider(deps, integration, options);
}

export * from "./binding.js";
