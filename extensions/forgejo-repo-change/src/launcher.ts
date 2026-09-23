import { createRepositoryChangeUiLauncher } from "@leitwerk-dev/coding/repository-change-launch";
import type {
	ForgejoGitIdentity,
	ForgejoIntegration,
	ForgejoRepository,
} from "@leitwerk-dev/forgejo";
import { createGitSshPreparationCheck, type GitSshIntegration } from "@leitwerk-dev/git-ssh";
import {
	type LaunchPreparationCheck,
	type ProcessLaunchConfig,
	SafeLaunchPreparationError,
} from "@leitwerk-dev/process-sdk";
import type { WoodpeckerIntegration } from "@leitwerk-dev/woodpecker";
import { type ForgejoRepoChangeParams, isIssueOrigin } from "./params.js";
import { type ProfileBindings, resolveProfileBinding } from "./profile-bindings.js";

/** @internal */
export const forgejoRepoChangeUiLauncherId = "forgejo_repo_change_process.ui_launcher" as const;

/** @internal */
export function forgejoRepoChangeParams(
	repository: ForgejoRepository,
	input: {
		/** @internal */
		profile: string;
		/** @internal */
		woodpeckerProfile: string;
		/** @internal */
		sshCredentialRef: string;
		/** @internal */
		prompt: string;
		/** @internal */
		workBranch: string;
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
): ProcessLaunchConfig<ForgejoRepoChangeParams> {
	const { owner, repo, forgejoProfile: profile, woodpeckerProfile } = params;
	const issue = isIssueOrigin(params);
	return {
		processId: "forgejo_repo_change_process",
		params,
		title,
		startTurnId: "generate_plan",
		...(issue
			? {
					externalId: `forgejo:${owner}/${repo}#${params.issueNumber}`,
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
					forgejo: { owner, repo, profile, ...(issue ? { issueNumber: params.issueNumber } : {}) },
					woodpecker: { owner, repo, profile: woodpeckerProfile },
					"leitwerk.gitIdentity": gitIdentity,
				},
			},
		],
	};
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
	let dependencies: LauncherDependencies | null = null;

	/** @internal */
	function configureForgejoRepoChangeLauncher(value: LauncherDependencies | null): void {
		dependencies = value;
	}

	function requireDependencies(): LauncherDependencies {
		if (!dependencies) throw new Error("Forgejo repository launcher is not configured");
		return dependencies;
	}

	/** @internal */
	function forgejoRepositoryPreparationChecks(
		_input: unknown,
		{ params }: ProcessLaunchConfig<ForgejoRepoChangeParams>,
	): readonly LaunchPreparationCheck<ForgejoRepoChangeParams>[] {
		return [
			{
				id: "repository_visibility",
				label: "Check repository visibility",
				async run({ signal }) {
					signal.throwIfAborted();
					const repositoryName = `${params.owner}/${params.repo}`;
					const visible = (await repositories(params.forgejoProfile)).some(
						(candidate) => candidate.full_name === repositoryName,
					);
					signal.throwIfAborted();
					if (!visible) {
						throw new SafeLaunchPreparationError(
							"Repository is not visible",
							"Grant the selected Forgejo profile access to the repository, then try again.",
						);
					}
				},
			},
			createGitSshPreparationCheck("read", params, () => requireDependencies().gitSsh),
			createGitSshPreparationCheck("write", params, () => requireDependencies().gitSsh),
		];
	}

	/** @internal */
	function resolveProfiles(profile: string) {
		const { forgejo, woodpecker, gitSsh, profileBindings = {} } = requireDependencies();
		if (!forgejo.profiles().includes(profile)) throw new Error("Forgejo profile is not available");
		const binding = resolveProfileBinding(profileBindings, profile);
		try {
			woodpecker.client(binding.woodpeckerProfile);
		} catch {
			throw new Error(`Woodpecker profile '${binding.woodpeckerProfile}' is not available`);
		}
		if (!gitSsh.profiles().includes(binding.sshCredentialRef))
			throw new Error(`Git SSH profile '${binding.sshCredentialRef}' is not available`);
		return binding;
	}

	/** @internal */
	async function resolveForgejoGitIdentity(profile: string): Promise<ForgejoGitIdentity> {
		if (!profile) throw new Error("A Forgejo profile is required to resolve Git identity");
		return requireDependencies().forgejo.client(profile).resolveGitIdentity(profile);
	}

	async function repositories(profile: string): Promise<readonly ForgejoRepository[]> {
		if (!profile) return [];
		const { forgejo } = requireDependencies();
		if (!forgejo.profiles().includes(profile)) return [];
		return forgejo.client(profile).listRepositories();
	}

	const forgejoRepoChangeUiLauncher = createRepositoryChangeUiLauncher({
		id: forgejoRepoChangeUiLauncherId,
		provider: "Forgejo",
		providerId: "forgejo",
		assertConfigured: requireDependencies,
		profiles: () => requireDependencies().forgejo.profiles(),
		repositories,
		resolveProfiles,
		resolveGitIdentity: resolveForgejoGitIdentity,
		params: forgejoRepoChangeParams,
		launchConfig: forgejoRepoChangeLaunchConfig,
		preparationChecks: forgejoRepositoryPreparationChecks,
	});

	return {
		/** @internal */
		configure: configureForgejoRepoChangeLauncher,
		/** @internal */
		preparationChecks: forgejoRepositoryPreparationChecks,
		/** @internal */
		resolveProfiles,
		/** @internal */
		resolveGitIdentity: resolveForgejoGitIdentity,
		/** @internal */
		launcher: forgejoRepoChangeUiLauncher,
	};
}
