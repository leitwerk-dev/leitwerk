import {
	createCapabilityToken,
	type RepositoryCredentialProject,
	type RepositoryCredentialRequirement,
} from "@leitwerk-dev/process-sdk";
import type { GitLabClientLike } from "./client.js";
import type { GitLabRepositoryCatalog } from "./repository-catalog.js";
/** @public */
export interface GitLabIntegration {
	/** @public */
	profiles(): readonly string[];
	/** @public */
	client(profile: string): GitLabClientLike;
	/** Cached repository metadata for Settings, supplied by server setup. @public */
	readonly repositoryCatalog?: GitLabRepositoryCatalog;
}
/** @public */
export const gitlabIntegration = createCapabilityToken<GitLabIntegration>(
	"@leitwerk-dev/gitlab.integration",
);
/** Internal references are derived from the same profile as API access. @public */
export function gitlabRepositoryCredentials(
	profile: string,
	projects: readonly RepositoryCredentialProject[],
): RepositoryCredentialRequirement[] {
	return projects.map((project) => ({
		projectKey: project.key,
		kind: "git_https",
		credentialRef: `gitlab:${profile}`,
	}));
}
