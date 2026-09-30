import { buildAutoWorkBranchFromSeed } from "@leitwerk-dev/coding/auto-work-branch";
import {
	repositoryChangeOptionFields,
	repositoryChangeOptions,
	repositoryChangeWorkflow,
} from "@leitwerk-dev/coding/repository-change-launch";
import { trimString } from "@leitwerk-dev/domain";
import { createGitSshPreparationCheck, type GitSshIntegration } from "@leitwerk-dev/git-ssh";
import {
	type GitLabIntegration,
	type GitLabIssueWatcherEvent,
	type GitLabProject,
	gitlabIssueExternalId,
} from "@leitwerk-dev/gitlab";
import {
	type LaunchPreparationCheck,
	type ProcessLaunchConfig,
	type ProcessLauncherDefinition,
	SafeLaunchPreparationError,
} from "@leitwerk-dev/process-sdk";
import type { GitLabRepoChangeParams } from "./params.js";

/** @public */
export function createGitLabRepoChangeLauncher() {
	let integration: GitLabIntegration | null = null;
	let ssh: GitSshIntegration | null = null;
	const requireIntegration = () => {
		if (!integration) throw new Error("GitLab repository launcher is not configured");
		return integration;
	};
	const configure = (
		value: GitLabIntegration | null,
		sshIntegration: GitSshIntegration | null = null,
	) => {
		integration = value;
		ssh = sshIntegration;
	};
	async function launch(
		repository: GitLabProject,
		profile: string,
		prompt: string,
		issue?: GitLabIssueWatcherEvent,
		options: {
			skipPlanDecision?: boolean;
			skipSimplification?: boolean;
			gitSshProfile?: string;
		} = {},
	): Promise<ProcessLaunchConfig<GitLabRepoChangeParams>> {
		const service = requireIntegration();
		if (!service.profiles().includes(profile)) throw new Error("GitLab profile is unavailable");
		const client = service.client(profile);
		const gitSshProfile =
			options.gitSshProfile ??
			issue?.gitSshProfile ??
			(ssh?.profiles().length === 1 ? ssh.profiles()[0] : "");
		if (!gitSshProfile || !ssh?.profiles().includes(gitSshProfile))
			throw new Error("Select a matching Git SSH profile");
		if (!repository.ssh_url_to_repo) throw new Error("GitLab repository has no SSH clone URL");
		const split = repository.path_with_namespace.lastIndexOf("/");
		if (split < 1) throw new Error("Invalid GitLab project path");
		const common = {
			gitlabProfile: profile,
			gitSshProfile,
			...repositoryChangeOptions(options),
			gitlabOrigin: client.baseUrl,
			projectId: repository.id,
			owner: repository.path_with_namespace.slice(0, split),
			repo: repository.path_with_namespace.slice(split + 1),
			repoLocator: repository.ssh_url_to_repo,
			baseBranch: repository.default_branch,
			workBranch: issue
				? `leitwerk/issue-${issue.issue.iid}`
				: buildAutoWorkBranchFromSeed(
						prompt,
						`${repository.http_url_to_repo}:${repository.default_branch}`,
					),
			prompt,
		};
		const params: GitLabRepoChangeParams = issue
			? {
					...common,
					origin: "issue",
					issueNumber: issue.issue.iid,
					issueUrl: issue.issue.web_url,
					triggerLabel: issue.labels.trigger,
					doneLabel: issue.labels.done,
				}
			: {
					...common,
					origin: "ui",
					issueNumber: null,
					issueUrl: null,
					triggerLabel: null,
					doneLabel: null,
				};
		const identity = await client.resolveGitIdentity();
		return {
			processId: "gitlab_repo_change_process",
			title: issue?.issue.title ?? prompt,
			params,
			startTurnId: "generate_plan",
			...(issue
				? {
						externalId: gitlabIssueExternalId(client.baseUrl, repository.id, issue.issue.iid),
						externalUrl: issue.issue.web_url,
					}
				: {}),
			projects: [
				{
					key: "repo",
					repoLocator: params.repoLocator,
					settingsRepository: {
						origin: new URL(repository.web_url).origin,
						repositoryId: repository.id,
						aliases: [
							repository.http_url_to_repo,
							...(repository.ssh_url_to_repo ? [repository.ssh_url_to_repo] : []),
						],
					},
					baseBranch: params.baseBranch,
					workBranch: params.workBranch,
					metadata: {
						gitlab: {
							origin: client.baseUrl,
							profile,
							projectId: repository.id,
							...(issue ? { issueIid: issue.issue.iid } : {}),
						},
						"leitwerk.gitIdentity": {
							provider: "gitlab",
							profile,
							login: identity.username,
							name: identity.name,
							email: identity.email,
						},
					},
				},
			],
		};
	}
	const preparationChecks = (
		_input: unknown,
		{ params }: ProcessLaunchConfig<GitLabRepoChangeParams>,
	): readonly LaunchPreparationCheck<GitLabRepoChangeParams>[] => [
		{
			id: "gitlab_repository_access",
			label: "Verify GitLab repository access",
			async run({ signal }) {
				const client = requireIntegration().client(params.gitlabProfile);
				const repository = await client.getProject(params.projectId, signal);
				if (
					repository.archived ||
					repository.ssh_url_to_repo !== params.repoLocator ||
					repository.default_branch !== params.baseBranch
				)
					throw new SafeLaunchPreparationError(
						"Repository changed or is archived",
						"Select an active GitLab project and launch again.",
					);
			},
		},
		createGitSshPreparationCheck(
			"write",
			{ ...params, sshCredentialRef: params.gitSshProfile ?? "" },
			() => {
				if (!params.gitSshProfile || !ssh) throw new Error("Git SSH profile is unavailable");
				return ssh;
			},
		),
	];
	const launcher: ProcessLauncherDefinition<GitLabRepoChangeParams> = {
		id: "gitlab_repo_change_process.ui_launcher",
		label: "GitLab Repo Change",
		description: "Plan, implement, review, and publish a GitLab merge request",
		visibility: "ui",
		ui: {
			card: {
				title: "GitLab Repo Change",
				description: "Start a repository change and publish a merge request.",
			},
			launchConfigSchema: {
				id: "gitlab_repo_change_form",
				title: "GitLab Repo Change",
				fields: [
					{ id: "gitlabProfile", label: "GitLab profile", kind: "select", required: true },
					{ id: "repository", label: "Project", kind: "select", required: true },
					{
						id: "gitSshProfile",
						label: "Git SSH profile",
						kind: "select",
						required: true,
						options: [],
					},
					{ id: "prompt", label: "Requested change", kind: "textarea", required: true },
					...repositoryChangeOptionFields,
				],
				submitLabel: "Start change",
			},
			resolveDefaults() {
				return {
					gitlabProfile: requireIntegration().profiles()[0] ?? "",
					repository: "",
					gitSshProfile: ssh?.profiles()[0] ?? "",
					prompt: "",
					...repositoryChangeOptions({}),
				};
			},
			async resolveOptions(input) {
				const i = requireIntegration();
				const profile = trimString(input.gitlabProfile);
				return {
					gitSshProfile: (ssh?.profiles() ?? []).map((value) => ({ value, label: value })),
					gitlabProfile: i.profiles().map((value) => ({ value, label: value })),
					repository: (i.profiles().includes(profile) ? await i.client(profile).listProjects() : [])
						.filter((p) => !p.archived && p.default_branch)
						.map((p) => ({
							value: String(p.id),
							label: p.path_with_namespace,
							description: p.web_url,
						})),
				};
			},
			preparationChecks,
			resolveRelaunchInput(input) {
				return {
					gitlabProfile: trimString(input.gitlabProfile),
					repository: trimString(input.repository),
					prompt: trimString(input.prompt),
					gitSshProfile: trimString(input.gitSshProfile),
					...repositoryChangeOptions(input),
				};
			},
			async resolveLaunchConfig(input) {
				const profile = trimString(input.gitlabProfile);
				const projectId = Number(input.repository);
				const prompt = trimString(input.prompt);
				const errors = [];
				if (!ssh?.profiles().includes(trimString(input.gitSshProfile)))
					errors.push({
						fieldId: "gitSshProfile",
						message: "Select an available Git SSH profile",
						code: "custom_rule" as const,
					});
				if (!requireIntegration().profiles().includes(profile))
					errors.push({
						fieldId: "gitlabProfile",
						message: "Select an available GitLab profile",
						code: "custom_rule" as const,
					});
				if (!Number.isSafeInteger(projectId) || projectId <= 0)
					errors.push({
						fieldId: "repository",
						message: "Select a project",
						code: "required" as const,
					});
				if (!prompt)
					errors.push({
						fieldId: "prompt",
						message: "Describe the requested change",
						code: "required" as const,
					});
				if (errors.length) return { ok: false, errors };
				const repository = await requireIntegration().client(profile).getProject(projectId);
				if (repository.archived || !repository.default_branch)
					return {
						ok: false,
						errors: [
							{
								fieldId: "repository",
								message: "Project is archived or has no default branch",
								code: "custom_rule",
							},
						],
					};
				return {
					ok: true,
					launchConfig: await launch(repository, profile, prompt, undefined, {
						gitSshProfile: trimString(input.gitSshProfile),
						...repositoryChangeOptions(input),
					}),
				};
			},
		},
	};
	return {
		/** @public */
		configure,

		/** @public */
		launcher,
		/** Server-side routing policies. @public */
		workflow: repositoryChangeWorkflow(async (params: GitLabRepoChangeParams) => {
			if (params.origin !== "issue") throw new Error("Missing GitLab source issue");
			const client = requireIntegration().client(params.gitlabProfile);
			if (client.baseUrl !== params.gitlabOrigin)
				throw new Error("GitLab profile installation changed from the source issue");
			return (await client.getIssue(params.projectId, params.issueNumber)).labels;
		}),

		/** @public */
		preparationChecks,

		/** @public */
		async fromIssue(event: GitLabIssueWatcherEvent) {
			return launch(
				event.repository,
				event.profile,
				`${event.issue.title}${event.issue.description ? `\n\n${event.issue.description}` : ""}`,
				event,
			);
		},
	};
}
