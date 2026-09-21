import type { ExternalWriteLogRepoLike } from "@leitwerk-dev/external-writes";
import { coreHostCapabilities, type LeitwerkExtensionModule } from "@leitwerk-dev/process-sdk";
import { type ForgejoIntegration, forgejoIntegration } from "./capability.js";
import { ForgejoClient, parseForgejoProfiles, parseForgejoTicketCreationConfig } from "./client.js";
import type { forgejoIssueWatcherSource } from "./issue-watcher.js";
import { createForgejoProvider } from "./provider.js";
import { registerForgejoTools } from "./tools.js";

/** @internal */
export const manifest = {
	/** @internal */
	id: "forgejo",
	/** @internal */
	version: "0.1.9",
} as const;

/** @public */
const extension: LeitwerkExtensionModule = {
	manifest,
	setupServer(api, config) {
		const profiles = parseForgejoProfiles(config);
		const ticketCreation = parseForgejoTicketCreationConfig(config);
		const integration: ForgejoIntegration = {
			profiles() {
				return [...profiles.keys()].sort();
			},
			client(profile) {
				const value = profiles.get(profile);
				if (!value) throw new Error(`Unknown Forgejo profile '${profile}'`);
				return new ForgejoClient(value);
			},
		};
		setupForgejoIntegration(api, integration, ticketCreation);
	},
};

export * from "./capability.js";
export * from "./client.js";
export * from "./external.js";
export * from "./issue-watcher.js";
export default extension;

/** Register shared tools and polling with an explicit integration. @public */
export function setupForgejoIntegration(
	api: Parameters<NonNullable<LeitwerkExtensionModule["setupServer"]>>[0],
	integration: ForgejoIntegration,
	ticketCreation: import("./client.js").ForgejoTicketCreationConfig = {
		defaultLabels: ["created-by-leitwerk"],
	},
	options: {
		/** @public */
		now?: () => number;
		/** @public */
		issueWatcherSource?: typeof forgejoIssueWatcherSource;
	} = {},
) {
	api.provide(forgejoIntegration, integration);
	const deps = api.get(coreHostCapabilities.serverSetup);
	if (!deps || Array.isArray(deps)) return;
	registerForgejoTools(
		api,
		integration,
		deps.externalWrites as ExternalWriteLogRepoLike,
		ticketCreation,
		deps.projects,
	);
	return createForgejoProvider(deps, integration, options.issueWatcherSource, options);
}

export * from "./binding.js";
