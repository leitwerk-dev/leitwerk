import {
	coreHostCapabilities,
	type LeitwerkExtensionModule,
	repositorySettingsIdentity,
	scopedSettingsCapability,
} from "@leitwerk-dev/process-sdk";
import { type GitHubIntegration, githubIntegration } from "./capability.js";
import { GitHubClient, parseGitHubProfiles } from "./client.js";
import { createGitHubProvider } from "./provider.js";
import { registerGitHubTools } from "./tools.js";

/** @internal */
const manifest = {
	id: "github",
	/** @internal */
	version: "0.1.9",
} as const;

/** @public */
const extension: LeitwerkExtensionModule = {
	manifest,
	setupServer(api, config) {
		const profiles = parseGitHubProfiles(config);
		const settings = api.get(scopedSettingsCapability);
		if (settings && !Array.isArray(settings))
			settings.registerDiscovery("repository", async () => {
				const subjects = [];
				for (const profile of profiles.values()) {
					for (const repo of await new GitHubClient(profile).listRepositories()) {
						if (repo.id === undefined) continue;
						subjects.push({
							scopeType: "repository",
							identity: repositorySettingsIdentity("https://github.com", repo.id),
							label: repo.full_name,
							aliases: [repo.ssh_url, ...(repo.clone_url ? [repo.clone_url] : [])],
						});
					}
				}
				return subjects;
			});
		const integration: GitHubIntegration = {
			profiles: () => [...profiles.keys()],
			client(profile) {
				const value = profiles.get(profile);
				if (!value) throw new Error(`Unknown GitHub profile '${profile}'`);
				return new GitHubClient(value);
			},
		};
		setupGitHubIntegration(api, integration);
	},
};

export default extension;

/** Register shared tools and polling with an explicit integration. @public */
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
	registerGitHubTools(api, integration);
	return createGitHubProvider(deps, integration, options);
}

export { resolveGitHubProjectBinding } from "./binding.js";
export type { GitHubIntegration } from "./capability.js";
export { githubIntegration } from "./capability.js";
export type {
	GitHubCheckSummary,
	GitHubGitIdentity,
	GitHubIssue,
	GitHubPullRequest,
	GitHubRepository,
} from "./client.js";
export {
	GITHUB_CHECKS_KIND,
	GITHUB_ISSUE_CANCELLED_KIND,
	GITHUB_PR_FEEDBACK_KIND,
	GITHUB_PR_STATE_KIND,
	GITHUB_PR_TERMINAL_KIND,
	githubExternal,
} from "./external.js";
export { githubIssueWatcherSource } from "./issue-watcher.js";
