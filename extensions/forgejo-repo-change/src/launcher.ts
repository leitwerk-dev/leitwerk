import {
	buildAutoWorkBranchFromSeed,
	generateAutoWorkBranchRandomHex,
} from "@leitwerk-dev/coding/auto-work-branch";
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
import type { ForgejoRepoChangeParams } from "./params.js";

export const forgejoRepoChangeUiLauncherId = "forgejo_repo_change_process.ui_launcher" as const;

interface LauncherDependencies {
	forgejo: ForgejoIntegration;
	gitSsh: GitSshIntegration;
}

let dependencies: LauncherDependencies | null = null;

export function configureForgejoRepoChangeLauncher(value: LauncherDependencies | null): void {
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

export function forgejoRepositoryPreparationChecks(
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

function text(input: Record<string, unknown>, name: string): string {
	return typeof input[name] === "string" ? input[name].trim() : "";
}

function validationError(
	fieldId: string,
	message: string,
	code: LauncherValidationError["code"] = "required",
): LauncherValidationError {
	return { code, fieldId, message };
}

export async function resolveForgejoGitIdentity(profile: string): Promise<ForgejoGitIdentity> {
	if (!profile) throw new Error("A Forgejo profile is required to resolve Git identity");
	return requireDependencies().forgejo.client(profile).resolveGitIdentity(profile);
}

async function repositories(profile: string): Promise<readonly ForgejoRepository[]> {
	if (!profile) return [];
	const { forgejo } = requireDependencies();
	if (!forgejo.profiles().includes(profile)) return [];
	return forgejo.client(profile).listRepositories();
}

export const forgejoRepoChangeUiLauncher: ProcessLauncherDefinition<ForgejoRepoChangeParams> = {
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
					description: "Server-owned Forgejo, Woodpecker, and Git SSH profile.",
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
			const profile = text(input, "forgejoProfile");
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
				forgejoProfile: text(previousInput, "forgejoProfile"),
				repository: text(previousInput, "repository"),
				prompt: text(previousInput, "prompt"),
			};
		},
		async resolveLaunchConfig(input) {
			const profile = text(input, "forgejoProfile");
			const repositoryName = text(input, "repository");
			const prompt = text(input, "prompt");
			const errors: LauncherValidationError[] = [];
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
			if (!repository) {
				return {
					ok: false,
					errors: [
						validationError(
							"repository",
							"Repository is not available to the selected Forgejo profile",
							"custom_rule",
						),
					],
				};
			}

			const owner = repository.owner.login;
			const repo = repository.name;
			const gitIdentity = await resolveForgejoGitIdentity(profile);
			const workBranch = buildAutoWorkBranchFromSeed(
				prompt,
				`${repository.ssh_url}:${repository.default_branch}`,
				generateAutoWorkBranchRandomHex(),
			);
			const params: ForgejoRepoChangeParams = {
				launchKind: "requested_change",
				repoLocator: repository.ssh_url,
				baseBranch: repository.default_branch,
				workBranch,
				prompt,
				forgejoProfile: profile,
				woodpeckerProfile: profile,
				sshCredentialRef: profile,
				owner,
				repo,
				origin: "ui",
				issueNumber: null,
				issueUrl: null,
				triggerLabel: null,
				doneLabel: null,
			};
			return {
				ok: true,
				launchConfig: {
					processId: "forgejo_repo_change_process",
					params,
					startTurnId: "generate_plan",
					title: prompt,
					projects: [
						{
							key: "repo",
							repoLocator: repository.ssh_url,
							baseBranch: repository.default_branch,
							workBranch,
							metadata: {
								forgejo: { owner, repo },
								"leitwerk.gitIdentity": gitIdentity,
							},
						},
					],
				},
			};
		},
	},
};
