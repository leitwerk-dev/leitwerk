import type { LeitwerkExtensionModule } from "@leitwerk-dev/process-sdk";
import { coreHostCapabilities } from "@leitwerk-dev/process-sdk";
import { GitLabClient, parseGitLabProfiles } from "./client.js";
import { setupGitLabIntegration } from "./setup.js";

/** @internal */
const manifest = {
	/** @internal */
	id: "gitlab",
	/** @internal */
	version: "0.1.9",
} as const;
/** @public */
const extension: LeitwerkExtensionModule = {
	manifest,
	setupServer(api, config) {
		const profiles = parseGitLabProfiles(config);
		const clients = new Map([...profiles].map(([id, profile]) => [id, new GitLabClient(profile)]));
		setupGitLabIntegration(api, {
			profiles: () => [...profiles.keys()],
			client: (profile) => {
				const client = clients.get(profile);
				if (!client) throw new Error(`Unknown GitLab profile '${profile}'`);
				return client;
			},
		});
		const deps = api.get(coreHostCapabilities.serverSetup);
		if (!deps || Array.isArray(deps)) return;
		deps.repositoryCredentials.register({
			kind: "git_https",
			resolve(ref) {
				const profile = ref.startsWith("gitlab:") ? profiles.get(ref.slice(7)) : undefined;
				return profile
					? { origin: profile.baseUrl, username: "oauth2", password: profile.token }
					: null;
			},
		});
	},
};
export default extension;
export type { GitLabIntegration } from "./capability.js";
export {
	gitlabIntegration,
	gitlabRepositoryCredentials,
} from "./capability.js";
export type {
	GitLabDiff,
	GitLabFeedback,
	GitLabIdentity,
	GitLabJob,
	GitLabMergeRequest,
	GitLabObservation,
	GitLabProject,
} from "./client.js";
export { observeMergeRequest } from "./client.js";
export type { GitLabDeliveryObservation } from "./external.js";
export {
	gitLabFeedbackReadyAt,
	gitlabExternal,
	observationKey,
	pendingGitLabFeedback,
} from "./external.js";
export type { GitLabIssueWatcherEvent } from "./issue-watcher.js";
export { gitlabIssueExternalId, gitlabIssueWatcherSource } from "./issue-watcher.js";
export type { GitLabSelection } from "./selection.js";
export {
	parseGitLabSelection,
	selectGitLabProjects,
} from "./selection.js";
export { ensureGitLabSeenReaction, resolveGitLabBinding } from "./tools.js";
