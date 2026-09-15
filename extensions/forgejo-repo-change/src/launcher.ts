import { buildAutoWorkBranchFromSeed } from "@leitwerk-dev/coding/auto-work-branch";
import { trimString } from "@leitwerk-dev/domain";
import type {
	ForgejoGitIdentity,
	ForgejoIntegration,
	ForgejoRepository,
} from "@leitwerk-dev/forgejo";
import type { GitSshIntegration } from "@leitwerk-dev/git-ssh";
import {
	type LauncherValidationError,
	type LaunchPreparationCheck,
	type ProcessLaunchConfig,
	type ProcessLauncherDefinition,
	SafeLaunchPreparationError,
} from "@leitwerk-dev/process-sdk";
import type { WoodpeckerIntegration } from "@leitwerk-dev/woodpecker";
import { type ForgejoRepoChangeParams, isIssueOrigin } from "./params.js";
import { type ProfileBindings, resolveProfileBinding } from "./profile-bindings.js";

export const forgejoRepoChangeUiLauncherId = "forgejo_repo_change_process.ui_launcher" as const;

export function forgejoRepoChangeParams(
	repository: ForgejoRepository,
	input: {
		profile: string;
		woodpeckerProfile: string;
		sshCredentialRef: string;
		prompt: string;
		workBranch: string;
	},
): ForgejoRepoChangeParams {
	return {
		launchKind: "requested_change",
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

export interface LauncherDependencies {
	forgejo: ForgejoIntegration;
	gitSsh: GitSshIntegration;
	woodpecker: WoodpeckerIntegration;
	profileBindings?: ProfileBindings;
}

export function createForgejoRepoChangeLauncher() {
	let dependencies: LauncherDependencies | null = null;

	function configureForgejoRepoChangeLauncher(value: LauncherDependencies | null): void {
		dependencies = value;
	}

	function requireDependencies(): LauncherDependencies {
		if (!dependencies) throw new Error("Forgejo repository launcher is not configured");
		return dependencies;
	}

	function sshPreparationCheck(
		access: "read" | "write",
		params: ForgejoRepoChangeParams,
	): LaunchPreparationCheck<ForgejoRepoChangeParams> {
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

	const forgejoRepoChangeUiLauncher: ProcessLauncherDefinition<ForgejoRepoChangeParams> = {
		id: forgejoRepoChangeUiLauncherId,
		label: "Forgejo Repo Change",
		description: "Plan, implement, review, and publish a Forgejo change without a source issue",
		visibility: "ui",
		ui: {
			card: {
				title: "Forgejo Repo Change",
				description: "Start a repository change and publish it as a Forgejo pull request.",
			},
			launchConfigSchema: {
				id: "forgejo_repo_change_form",
				title: "Forgejo Repo Change",
				fields: [
					{
						id: "forgejoProfile",
						label: "Forgejo profile",
						kind: "select",
						required: true,
						description: "Forgejo profile with server-configured CI and Git SSH access.",
					},
					{
						id: "repository",
						label: "Repository",
						kind: "select",
						required: true,
						description: "Repository visible to the selected Forgejo profile.",
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
					forgejoProfile: requireDependencies().forgejo.profiles()[0] ?? "",
					repository: "",
					prompt: "",
				};
			},
			async resolveOptions(input) {
				const { forgejo } = requireDependencies();
				const profile = trimString(input.forgejoProfile);
				return {
					forgejoProfile: forgejo.profiles().map((value) => ({ value, label: value })),
					repository: (await repositories(profile)).map((repository) => ({
						value: repository.full_name,
						label: repository.full_name,
						description: repository.html_url,
					})),
				};
			},
			preparationChecks: forgejoRepositoryPreparationChecks,
			resolveRelaunchInput(previousInput) {
				return {
					forgejoProfile: trimString(previousInput.forgejoProfile),
					repository: trimString(previousInput.repository),
					prompt: trimString(previousInput.prompt),
				};
			},
			async resolveLaunchConfig(input) {
				const profile = trimString(input.forgejoProfile);
				const repositoryName = trimString(input.repository);
				const prompt = trimString(input.prompt);
				const errors: LauncherValidationError[] = [];
				const invalid = (fieldId: string, message: string) => ({
					ok: false as const,
					errors: [validationError(fieldId, message, "custom_rule")],
				});
				const { forgejo } = requireDependencies();
				if (!profile) errors.push(validationError("forgejoProfile", "Forgejo profile is required"));
				else if (!forgejo.profiles().includes(profile))
					errors.push(
						validationError("forgejoProfile", "Forgejo profile is not available", "custom_rule"),
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
						"Repository is not available to the selected Forgejo profile",
					);

				let binding: ReturnType<typeof resolveProfiles>;
				try {
					binding = resolveProfiles(profile);
				} catch (error) {
					return invalid("forgejoProfile", (error as Error).message);
				}
				const gitIdentity = await resolveForgejoGitIdentity(profile);
				const workBranch = buildAutoWorkBranchFromSeed(
					prompt,
					`${repository.ssh_url}:${repository.default_branch}`,
				);
				const params = forgejoRepoChangeParams(repository, {
					...binding,
					profile,
					prompt,
					workBranch,
				});
				return {
					ok: true,
					launchConfig: forgejoRepoChangeLaunchConfig(params, prompt, gitIdentity),
				};
			},
		},
	};

	return {
		configure: configureForgejoRepoChangeLauncher,
		preparationChecks: forgejoRepositoryPreparationChecks,
		resolveProfiles,
		resolveGitIdentity: resolveForgejoGitIdentity,
		launcher: forgejoRepoChangeUiLauncher,
	};
}
