import { buildAutoWorkBranchFromSeed } from "@leitwerk-dev/coding/auto-work-branch";
import { trimString } from "@leitwerk-dev/domain";
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
	const requireIntegration = () => {
		if (!integration) throw new Error("GitLab repository launcher is not configured");
		return integration;
	};
	const configure = (value: GitLabIntegration | null) => {
		integration = value;
	};
	async function launch(
		repository: GitLabProject,
		profile: string,
		prompt: string,
		issue?: GitLabIssueWatcherEvent,
	): Promise<ProcessLaunchConfig<GitLabRepoChangeParams>> {
		const service = requireIntegration();
		if (!service.profiles().includes(profile)) throw new Error("GitLab profile is unavailable");
		const client = service.client(profile);
		const split = repository.path_with_namespace.lastIndexOf("/");
		if (split < 1) throw new Error("Invalid GitLab project path");
		const common = {
			gitlabProfile: profile,
			gitlabOrigin: client.baseUrl,
			projectId: repository.id,
			owner: repository.path_with_namespace.slice(0, split),
			repo: repository.path_with_namespace.slice(split + 1),
			repoLocator: repository.http_url_to_repo,
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
					baseBranch: params.baseBranch,
					workBranch: params.workBranch,
					metadata: {
						gitlab: {
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
			label: "Verify GitLab repository and HTTPS read/write access",
			async run({ signal }) {
				const client = requireIntegration().client(params.gitlabProfile);
				const repository = await client.getProject(params.projectId, signal);
				if (
					repository.archived ||
					repository.http_url_to_repo !== params.repoLocator ||
					repository.default_branch !== params.baseBranch
				)
					throw new SafeLaunchPreparationError(
						"Repository changed or is archived",
						"Select an active GitLab project and launch again.",
					);
				await client.preflightRepository(
					params.projectId,
					params.baseBranch,
					params.workBranch,
					signal,
				);
			},
		},
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
					{ id: "prompt", label: "Requested change", kind: "textarea", required: true },
				],
				submitLabel: "Start change",
			},
			resolveDefaults() {
				return {
					gitlabProfile: requireIntegration().profiles()[0] ?? "",
					repository: "",
					prompt: "",
				};
			},
			async resolveOptions(input) {
				const i = requireIntegration();
				const profile = trimString(input.gitlabProfile);
				return {
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
				};
			},
			async resolveLaunchConfig(input) {
				const profile = trimString(input.gitlabProfile);
				const projectId = Number(input.repository);
				const prompt = trimString(input.prompt);
				const errors = [];
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
				return { ok: true, launchConfig: await launch(repository, profile, prompt) };
			},
		},
	};
	return {
		/** @public */
		configure,
		/** @public */
		launcher,
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
