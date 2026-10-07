import type { LeitwerkExtensionModule } from "@leitwerk-dev/process-sdk";
import { coreHostCapabilities, parseTicketCreationConfig } from "@leitwerk-dev/process-sdk";
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
		setupGitLabIntegration(
			api,
			{
				profiles: () => [...profiles.keys()],
				client: (profile) => {
					const client = clients.get(profile);
					if (!client) throw new Error(`Unknown GitLab profile '${profile}'`);
					return client;
				},
			},
			{ ticketCreation: parseTicketCreationConfig(config, "GitLab") },
		);
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
	GitLabClientLike,
	GitLabDiff,
	GitLabFeedback,
	GitLabIdentity,
	GitLabJob,
	GitLabLabelEvent,
	GitLabMergeRequest,
	GitLabObservation,
	GitLabProject,
} from "./client.js";
export { GitLabError, observeMergeRequest } from "./client.js";
export type { GitLabDeliveryObservation } from "./external.js";
export {
	gitLabFeedbackReadyAt,
	gitlabExternal,
	observationKey,
	pendingGitLabFeedback,
} from "./external.js";
export type { GitLabIssueWatcherEvent } from "./issue-watcher.js";
export { gitlabIssueExternalId, gitlabIssueWatcherSource } from "./issue-watcher.js";
export { resolveGitLabLaunchProject } from "./launch.js";
export {
	GITLAB_MAINTAINED_KIND,
	type GitLabMaintainedBinding,
	type GitLabMaintainedProcess,
	type GitLabMaintenance,
	type GitLabMaintenanceContext,
	type GitLabMaintenanceDecision,
	type GitLabMaintenanceDestinations,
	type GitLabMaintenanceEvent,
	type GitLabMaintenanceMessage,
	type GitLabMaintenanceRecord,
	type GitLabMaintenanceRetry,
	type GitLabMaintenanceSettings,
	gitlabMaintenance,
	gitlabMaintenanceSource,
	registerGitLabMaintainedProcess,
} from "./maintenance.js";
export {
	GITLAB_ACTIVE_LABEL,
	GITLAB_DONE_LABEL,
	type GitLabLabelState,
	gitLabActivationStatus,
	readGitLabLabels,
} from "./maintenance-labels.js";
export {
	createGitLabPublicationAdapter,
	type GitLabPublicationParams,
	gitlabPublicationEvidenceForRequest,
	gitlabPublicationRequest,
	gitlabPublicationSource,
} from "./publication.js";
export {
	createGitLabRepositoryCatalog,
	type GitLabRepositoryCatalog,
} from "./repository-catalog.js";
export type { GitLabSelection } from "./selection.js";
export {
	parseGitLabSelection,
	selectGitLabProjects,
} from "./selection.js";
export {
	ensureGitLabComment,
	ensureGitLabSeenReaction,
	gitLabCommentMarker,
	resolveGitLabBinding,
	resolveGitLabRepositoryBinding,
} from "./tools.js";
