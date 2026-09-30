import {
	createRepositoryChangeLauncher,
	type PullRequestChangeLaunchInput,
	repositoryIssueChangeLaunchConfig,
} from "@leitwerk-dev/coding/repository-change-launch";
import type {
	ForgejoGitIdentity,
	ForgejoIntegration,
	ForgejoRepository,
} from "@leitwerk-dev/forgejo";
import { createGitSshPreparationCheck, type GitSshIntegration } from "@leitwerk-dev/git-ssh";
import type { ProcessLaunchConfig } from "@leitwerk-dev/process-sdk";
import type { WoodpeckerIntegration } from "@leitwerk-dev/woodpecker";
import { type ForgejoRepoChangeParams, isIssueOrigin } from "./params.js";
import { type ProfileBindings, resolveProfileBinding } from "./profile-bindings.js";

/** @internal */
export const forgejoRepoChangeUiLauncherId = "forgejo_repo_change_process.ui_launcher" as const;

/** @internal */
export function forgejoRepoChangeParams(
	repository: ForgejoRepository,
	input: PullRequestChangeLaunchInput & {
		/** @internal */
		woodpeckerProfile: string;
	},
): ForgejoRepoChangeParams {
	return {
		repoLocator: repository.ssh_url,
		baseBranch: repository.default_branch,
		workBranch: input.workBranch,
		prompt: input.prompt,
		forgejoProfile: input.profile,
		woodpeckerProfile: input.woodpeckerProfile,
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

/** @internal */
export function forgejoRepoChangeLaunchConfig(
	params: ForgejoRepoChangeParams,
	title: string,
	gitIdentity: ForgejoGitIdentity,
	repository?: ForgejoRepository,
): ProcessLaunchConfig<ForgejoRepoChangeParams> {
	const { owner, repo, forgejoProfile: profile, woodpeckerProfile } = params;
	const issue = isIssueOrigin(params);
	return repositoryIssueChangeLaunchConfig(
		"forgejo",
		params,
		title,
		`${owner}/${repo}`,
		{
			forgejo: { owner, repo, profile, ...(issue ? { issueNumber: params.issueNumber } : {}) },
			woodpecker: { owner, repo, profile: woodpeckerProfile },
			"leitwerk.gitIdentity": gitIdentity,
		},
		repository,
	);
}

/** @internal */
export interface LauncherDependencies {
	/** @internal */
	forgejo: ForgejoIntegration;
	/** @internal */
	gitSsh: GitSshIntegration;
	/** @internal */
	woodpecker: WoodpeckerIntegration;
	/** @internal */
	profileBindings?: ProfileBindings;
}

/** @internal */
export function createForgejoRepoChangeLauncher() {
	return createRepositoryChangeLauncher({
		id: forgejoRepoChangeUiLauncherId,
		provider: "Forgejo",
		providerId: "forgejo",
		integration: (deps: LauncherDependencies) => deps.forgejo,
		profile: (params: ForgejoRepoChangeParams) => params.forgejoProfile,
		params: forgejoRepoChangeParams,
		launchConfig: forgejoRepoChangeLaunchConfig,
		resolveProfiles(profile, { woodpecker, gitSsh, profileBindings = {} }) {
			const binding = resolveProfileBinding(profileBindings, profile);
			try {
				woodpecker.client(binding.woodpeckerProfile);
			} catch {
				throw new Error(`Woodpecker profile '${binding.woodpeckerProfile}' is not available`);
			}
			if (!gitSsh.profiles().includes(binding.sshCredentialRef))
				throw new Error(`Git SSH profile '${binding.sshCredentialRef}' is not available`);
			return binding;
		},
		preparationChecks: (params, dependencies) => [
			createGitSshPreparationCheck("write", params, () => dependencies().gitSsh),
		],
	});
}
