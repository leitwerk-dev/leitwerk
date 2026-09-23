import { createRepositoryChangeUiLauncher } from "@leitwerk-dev/coding/repository-change-launch";
import { createGitSshPreparationCheck, type GitSshIntegration } from "@leitwerk-dev/git-ssh";
import type { GitHubGitIdentity, GitHubIntegration, GitHubRepository } from "@leitwerk-dev/github";
import {
	type LaunchPreparationCheck,
	type ProcessLaunchConfig,
	SafeLaunchPreparationError,
} from "@leitwerk-dev/process-sdk";
import { type GitHubRepoChangeParams, isIssueOrigin } from "./params.js";
import { type ProfileBindings, resolveProfileBinding } from "./profile-bindings.js";

/** @public */
export const githubRepoChangeUiLauncherId = "github_repo_change_process.ui_launcher" as const;

/** @public */
export function githubRepoChangeParams(
	repository: GitHubRepository,
	input: {
		/** @public */
		profile: string;
		/** @public */
		sshCredentialRef: string;
		/** @public */
		prompt: string;
		/** @public */
		workBranch: string;
	},
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
): ProcessLaunchConfig<GitHubRepoChangeParams> {
	const { owner, repo, githubProfile: profile } = params;
	const issue = isIssueOrigin(params);
	return {
		processId: "github_repo_change_process",
		params,
		title,
		startTurnId: "generate_plan",
		...(issue
			? {
					externalId: `github:${owner}/${repo}#${params.issueNumber}`,
					externalUrl: params.issueUrl,
				}
			: {}),
		projects: [
			{
				key: "repo",
				repoLocator: params.repoLocator,
				baseBranch: params.baseBranch,
				workBranch: params.workBranch,
				...(issue ? { externalId: String(params.issueNumber), externalUrl: params.issueUrl } : {}),
				metadata: {
					github: { owner, repo, profile, ...(issue ? { issueNumber: params.issueNumber } : {}) },
					"leitwerk.gitIdentity": gitIdentity,
				},
			},
		],
	};
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
	let dependencies: LauncherDependencies | null = null;

	/** @public */
	function configureGitHubRepoChangeLauncher(value: LauncherDependencies | null): void {
		dependencies = value;
	}

	function requireDependencies(): LauncherDependencies {
		if (!dependencies) throw new Error("GitHub repository launcher is not configured");
		return dependencies;
	}

	/** @public */
	function githubRepositoryPreparationChecks(
		_input: unknown,
		{ params }: ProcessLaunchConfig<GitHubRepoChangeParams>,
	): readonly LaunchPreparationCheck<GitHubRepoChangeParams>[] {
		return [
			{
				id: "repository_visibility",
				label: "Check repository visibility",
				async run({ signal }) {
					signal.throwIfAborted();
					const repositoryName = `${params.owner}/${params.repo}`;
					const visible = (await repositories(params.githubProfile)).some(
						(candidate) => candidate.full_name === repositoryName,
					);
					signal.throwIfAborted();
					if (!visible) {
						throw new SafeLaunchPreparationError(
							"Repository is not visible",
							"Grant the selected GitHub profile access to the repository, then try again.",
						);
					}
				},
			},
			createGitSshPreparationCheck("read", params, () => requireDependencies().gitSsh),
			createGitSshPreparationCheck("write", params, () => requireDependencies().gitSsh),
		];
	}

	/** @public */
	function resolveProfiles(profile: string) {
		const { github, gitSsh, profileBindings = {} } = requireDependencies();
		if (!(github.profiles?.() ?? []).includes(profile))
			throw new Error("GitHub profile is not available");
		const binding = resolveProfileBinding(profileBindings, profile);

		if (!gitSsh.profiles().includes(binding.sshCredentialRef))
			throw new Error(`Git SSH profile '${binding.sshCredentialRef}' is not available`);
		return binding;
	}

	/** @public */
	async function resolveGitHubGitIdentity(profile: string): Promise<GitHubGitIdentity> {
		if (!profile) throw new Error("A GitHub profile is required to resolve Git identity");
		return requireDependencies().github.client(profile).resolveGitIdentity(profile);
	}

	async function repositories(profile: string): Promise<readonly GitHubRepository[]> {
		if (!profile) return [];
		const { github } = requireDependencies();
		if (!(github.profiles?.() ?? []).includes(profile)) return [];
		return github.client(profile).listRepositories();
	}

	const githubRepoChangeUiLauncher = createRepositoryChangeUiLauncher({
		id: githubRepoChangeUiLauncherId,
		provider: "GitHub",
		providerId: "github",
		assertConfigured: requireDependencies,
		profiles: () => requireDependencies().github.profiles?.() ?? [],
		repositories,
		resolveProfiles,
		resolveGitIdentity: resolveGitHubGitIdentity,
		params: githubRepoChangeParams,
		launchConfig: githubRepoChangeLaunchConfig,
		preparationChecks: githubRepositoryPreparationChecks,
	});

	return {
		/** @public */
		configure: configureGitHubRepoChangeLauncher,
		/** @public */
		preparationChecks: githubRepositoryPreparationChecks,
		/** @public */
		resolveProfiles,
		/** @public */
		resolveGitIdentity: resolveGitHubGitIdentity,
		/** @public */
		launcher: githubRepoChangeUiLauncher,
	};
}
