import {
	coreHostCapabilities,
	type LeitwerkExtensionModule,
	repositorySettingsIdentity,
	scopedSettingsCapability,
} from "@leitwerk-dev/process-sdk";
import { type ForgejoIntegration, forgejoIntegration } from "./capability.js";
import { ForgejoClient, parseForgejoProfiles, parseForgejoTicketCreationConfig } from "./client.js";
import type { forgejoIssueWatcherSource } from "./issue-watcher.js";
import { createForgejoProvider } from "./provider.js";
import { registerForgejoTools } from "./tools.js";

/** @internal */
const manifest = {
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
		const settings = api.get(scopedSettingsCapability);
		if (settings && !Array.isArray(settings))
			settings.registerDiscovery("repository", async () => {
				const subjects = [];
				for (const profile of profiles.values()) {
					for (const repo of await new ForgejoClient(profile).listRepositories()) {
						if (repo.id === undefined) continue;
						subjects.push({
							scopeType: "repository",
							identity: repositorySettingsIdentity(profile.baseUrl, repo.id),
							label: repo.full_name,
							aliases: [repo.ssh_url, ...(repo.clone_url ? [repo.clone_url] : [])],
						});
					}
				}
				return subjects;
			});
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
	registerForgejoTools(api, integration, ticketCreation, deps.projects);
	return createForgejoProvider(deps, integration, options.issueWatcherSource, options);
}

export { resolveForgejoProjectBinding } from "./binding.js";
export type { ForgejoIntegration } from "./capability.js";
export { forgejoIntegration } from "./capability.js";
export {
	ForgejoClient,
	type ForgejoGitIdentity,
	type ForgejoIssue,
	type ForgejoPullRequest,
	type ForgejoRepository,
} from "./client.js";
export {
	FORGEJO_ISSUE_CANCELLED_KIND,
	FORGEJO_PR_CONFLICT_KIND,
	FORGEJO_PR_FEEDBACK_KIND,
	FORGEJO_PR_TERMINAL_KIND,
	forgejoExternal,
} from "./external.js";
export { forgejoIssueWatcherSource } from "./issue-watcher.js";
