import type { ExternalWriteLogRepoLike } from "@leitwerk-dev/external-writes";
import { coreHostCapabilities, type LeitwerkExtensionModule } from "@leitwerk-dev/process-sdk";
import { type GitHubIntegration, githubIntegration } from "./capability.js";
import { GitHubClient, parseGitHubProfiles } from "./client.js";
import { createGitHubProvider } from "./provider.js";
import { registerGitHubTools } from "./tools.js";

/** @public */
export const manifest = {
	/** @public */
	id: "github",
	/** @internal */
	version: "0.1.9",
} as const;

/** @public */
const extension: LeitwerkExtensionModule = {
	manifest,
	setupServer(api, config) {
		const profiles = parseGitHubProfiles(config);
		const integration: GitHubIntegration = {
			client(profile) {
				const value = profiles.get(profile);
				if (!value) throw new Error(`Unknown GitHub profile '${profile}'`);
				return new GitHubClient(value);
			},
		};
		setupGitHubIntegration(api, integration);
	},
};

export * from "./capability.js";
export * from "./client.js";
export * from "./external.js";
export default extension;

/** Register shared tools and polling with an explicit integration. */
/** @public */
export function setupGitHubIntegration(
	api: Parameters<NonNullable<LeitwerkExtensionModule["setupServer"]>>[0],
	integration: GitHubIntegration,
	options: {
		/** @public */
		now?: () => number;
	} = {},
) {
	api.provide(githubIntegration, integration);
	const deps = api.get(coreHostCapabilities.serverSetup);
	if (!deps || Array.isArray(deps)) return;
	registerGitHubTools(api, integration, deps.externalWrites as ExternalWriteLogRepoLike);
	return createGitHubProvider(deps, integration, options);
}

export * from "./binding.js";

export * from "./issue-watcher.js";
