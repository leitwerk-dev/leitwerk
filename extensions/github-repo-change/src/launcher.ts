import {
	createRepositoryChangeLauncher,
	type PullRequestChangeLaunchInput,
	repositoryIssueChangeLaunchConfig,
} from "@leitwerk-dev/coding/repository-change-launch";
import { createGitSshPreparationCheck, type GitSshIntegration } from "@leitwerk-dev/git-ssh";
import type { GitHubGitIdentity, GitHubIntegration, GitHubRepository } from "@leitwerk-dev/github";
import type { ProcessLaunchConfig } from "@leitwerk-dev/process-sdk";
import { type GitHubRepoChangeParams, isIssueOrigin } from "./params.js";
import { type ProfileBindings, resolveProfileBinding } from "./profile-bindings.js";

/** @public */
export const githubRepoChangeUiLauncherId = "github_repo_change_process.ui_launcher" as const;

/** @public */
export function githubRepoChangeParams(
	repository: GitHubRepository,
	input: PullRequestChangeLaunchInput,
): GitHubRepoChangeParams {
	return {
		repoLocator: repository.ssh_url,
		baseBranch: repository.default_branch,
		workBranch: input.workBranch,
		prompt: input.prompt,
		githubProfile: input.profile,
		sshCredentialRef: input.sshCredentialRef,
		owner: repository.owner.login,
		repo: repository.name,
		origin: "ui",
		issueNumber: null,
		issueUrl: null,
		triggerLabel: null,
		doneLabel: null,
	};
}

/** @public */
export function githubRepoChangeLaunchConfig(
	params: GitHubRepoChangeParams,
	title: string,
	gitIdentity: GitHubGitIdentity,
	repository?: GitHubRepository,
): ProcessLaunchConfig<GitHubRepoChangeParams> {
	const { owner, repo, githubProfile: profile } = params;
	const issue = isIssueOrigin(params);
	return repositoryIssueChangeLaunchConfig(
		"github",
		params,
		title,
		`${owner}/${repo}`,
		{
			github: { owner, repo, profile, ...(issue ? { issueNumber: params.issueNumber } : {}) },
			"leitwerk.gitIdentity": gitIdentity,
		},
		repository,
	);
}

/** @public */
export interface LauncherDependencies {
	/** @public */
	github: GitHubIntegration;
	/** @public */
	gitSsh: GitSshIntegration;
	/** @public */
	profileBindings?: ProfileBindings;
}

/** @public */
export function createGitHubRepoChangeLauncher() {
	return createRepositoryChangeLauncher({
		id: githubRepoChangeUiLauncherId,
		provider: "GitHub",
		providerId: "github",
		integration: (deps: LauncherDependencies) => deps.github,
		profile: (params: GitHubRepoChangeParams) => params.githubProfile,
		params: githubRepoChangeParams,
		launchConfig: githubRepoChangeLaunchConfig,
		resolveProfiles(profile, { gitSsh, profileBindings = {} }) {
			const binding = resolveProfileBinding(profileBindings, profile);
			if (!gitSsh.profiles().includes(binding.sshCredentialRef))
				throw new Error(`Git SSH profile '${binding.sshCredentialRef}' is not available`);
			return binding;
		},
		preparationChecks: (params, dependencies) => [
			createGitSshPreparationCheck("write", params, () => dependencies().gitSsh),
		],
	});
}
