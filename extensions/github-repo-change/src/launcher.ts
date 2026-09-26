import { buildAutoWorkBranchFromSeed } from "@leitwerk-dev/coding/auto-work-branch";
import { trimString } from "@leitwerk-dev/domain";
import type { GitSshIntegration } from "@leitwerk-dev/git-ssh";
import type { GitHubGitIdentity, GitHubIntegration, GitHubRepository } from "@leitwerk-dev/github";
import {
	type LauncherValidationError,
	type LaunchPreparationCheck,
	type ProcessLaunchConfig,
	type ProcessLauncherDefinition,
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
	repository?: GitHubRepository,
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
				...(repository?.id !== undefined
					? {
							settingsRepository: {
								origin: new URL(repository.html_url).origin,
								repositoryId: repository.id,
								aliases: [
									repository.ssh_url,
									...(repository.clone_url ? [repository.clone_url] : []),
								],
							},
						}
					: {}),
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

	function sshPreparationCheck(
		access: "read" | "write",
		params: GitHubRepoChangeParams,
	): LaunchPreparationCheck<GitHubRepoChangeParams> {
		return {
			id: `ssh_${access}`,
			label: `Verify SSH ${access} access`,
			async run({ signal, logger }) {
				signal.throwIfAborted();
				const result = await requireDependencies().gitSsh.preflight({
					credentialRef: params.sshCredentialRef,
					repoLocator: params.repoLocator,
					baseBranch: params.baseBranch,
					requireWrite: access === "write",
				});
				signal.throwIfAborted();
				if (!result.ok) {
					logger.warn(`Git SSH ${result.access} preflight failed: ${result.detail}`);
					throw new SafeLaunchPreparationError(
						`SSH ${result.access} access failed: ${result.detail}`,
						`Authorize Git SSH profile '${params.sshCredentialRef}' for '${params.owner}/${params.repo}' with read/write access, then try again.`,
					);
				}
			},
		};
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
			sshPreparationCheck("read", params),
			sshPreparationCheck("write", params),
		];
	}

	function validationError(
		fieldId: string,
		message: string,
		code: LauncherValidationError["code"] = "required",
	): LauncherValidationError {
		return { code, fieldId, message };
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

	const githubRepoChangeUiLauncher: ProcessLauncherDefinition<GitHubRepoChangeParams> = {
		id: githubRepoChangeUiLauncherId,
		label: "GitHub Repo Change",
		description: "Plan, implement, review, and publish a GitHub change without a source issue",
		visibility: "ui",
		ui: {
			card: {
				title: "GitHub Repo Change",
				description: "Start a repository change and publish it as a GitHub pull request.",
			},
			launchConfigSchema: {
				id: "github_repo_change_form",
				title: "GitHub Repo Change",
				fields: [
					{
						id: "githubProfile",
						label: "GitHub profile",
						kind: "select",
						required: true,
						description: "GitHub profile with server-configured CI and Git SSH access.",
					},
					{
						id: "repository",
						label: "Repository",
						kind: "select",
						required: true,
						description: "Repository visible to the selected GitHub profile.",
					},
					{
						id: "prompt",
						label: "Requested change",
						kind: "textarea",
						required: true,
						placeholder: "Describe the change to plan, implement, review, and publish.",
					},
				],
				submitLabel: "Start change",
			},
			resolveDefaults() {
				return {
					githubProfile: (requireDependencies().github.profiles?.() ?? [])[0] ?? "",
					repository: "",
					prompt: "",
				};
			},
			async resolveOptions(input) {
				const { github } = requireDependencies();
				const profile = trimString(input.githubProfile);
				return {
					githubProfile: (github.profiles?.() ?? []).map((value) => ({ value, label: value })),
					repository: (await repositories(profile)).map((repository) => ({
						value: repository.full_name,
						label: repository.full_name,
						description: repository.html_url,
					})),
				};
			},
			preparationChecks: githubRepositoryPreparationChecks,
			resolveRelaunchInput(previousInput) {
				return {
					githubProfile: trimString(previousInput.githubProfile),
					repository: trimString(previousInput.repository),
					prompt: trimString(previousInput.prompt),
				};
			},
			async resolveLaunchConfig(input) {
				const profile = trimString(input.githubProfile);
				const repositoryName = trimString(input.repository);
				const prompt = trimString(input.prompt);
				const errors: LauncherValidationError[] = [];
				const invalid = (fieldId: string, message: string) => ({
					ok: false as const,
					errors: [validationError(fieldId, message, "custom_rule")],
				});
				const { github } = requireDependencies();
				if (!profile) errors.push(validationError("githubProfile", "GitHub profile is required"));
				else if (!(github.profiles?.() ?? []).includes(profile))
					errors.push(
						validationError("githubProfile", "GitHub profile is not available", "custom_rule"),
					);
				if (!repositoryName) errors.push(validationError("repository", "Repository is required"));
				if (!prompt) errors.push(validationError("prompt", "Requested change is required"));
				if (errors.length > 0) return { ok: false, errors };

				const repository = (await repositories(profile)).find(
					(candidate) => candidate.full_name === repositoryName,
				);
				if (!repository)
					return invalid(
						"repository",
						"Repository is not available to the selected GitHub profile",
					);

				let binding: ReturnType<typeof resolveProfiles>;
				try {
					binding = resolveProfiles(profile);
				} catch (error) {
					return invalid("githubProfile", (error as Error).message);
				}
				const gitIdentity = await resolveGitHubGitIdentity(profile);
				const workBranch = buildAutoWorkBranchFromSeed(
					prompt,
					`${repository.ssh_url}:${repository.default_branch}`,
				);
				const params = githubRepoChangeParams(repository, {
					...binding,
					profile,
					prompt,
					workBranch,
				});
				return {
					ok: true,
					launchConfig: githubRepoChangeLaunchConfig(params, prompt, gitIdentity, repository),
				};
			},
		},
	};

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
