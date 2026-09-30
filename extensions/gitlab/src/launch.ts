import type { GitLabClientLike, GitLabProject } from "./client.js";

/** Resolve the shared checkout, provider binding and pinned Git identity. @internal */
export async function resolveGitLabLaunchProject(
	client: GitLabClientLike,
	profile: string,
	repository: GitLabProject,
	workBranch: string,
	key = "repo",
) {
	if (!repository.ssh_url_to_repo) throw new Error("GitLab repository has no SSH clone URL");
	const split = repository.path_with_namespace.lastIndexOf("/");
	if (split < 1) throw new Error("Invalid GitLab project path");
	const params = {
		/** @internal */ gitlabProfile: profile,
		/** @internal */ gitlabOrigin: client.baseUrl,
		/** @internal */ projectId: repository.id,
		/** @internal */ owner: repository.path_with_namespace.slice(0, split),
		/** @internal */ repo: repository.path_with_namespace.slice(split + 1),
		/** @internal */ repoLocator: repository.ssh_url_to_repo,
		/** @internal */ baseBranch: repository.default_branch,
		/** @internal */ workBranch,
	};
	const identity = await client.resolveGitIdentity();
	return {
		/** @internal */ params,
		/** @internal */ project: {
			/** @internal */ key,
			/** @internal */ repoLocator: params.repoLocator,
			/** @internal */ baseBranch: params.baseBranch,
			/** @internal */ workBranch,
			/** @internal */ settingsRepository: {
				/** @internal */ origin: client.baseUrl,
				/** @internal */ repositoryId: repository.id,
				/** @internal */ aliases: [repository.http_url_to_repo, repository.ssh_url_to_repo],
			},
			/** @internal */ metadata: {
				/** @internal */ gitlab: {
					/** @internal */ origin: client.baseUrl,
					/** @internal */ profile,
					/** @internal */ projectId: repository.id,
				},
				/** @internal */ "leitwerk.gitIdentity": {
					/** @internal */ provider: "gitlab",
					/** @internal */ profile,
					/** @internal */ login: identity.username,
					/** @internal */ name: identity.name,
					/** @internal */ email: identity.email,
				},
			},
		},
	};
}
