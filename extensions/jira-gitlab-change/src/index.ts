import { createRepositoryChangeProcess } from "@leitwerk-dev/coding";
import {
	createRepositoryChangePublication,
	type PublicationSource,
	readPublicationState,
} from "@leitwerk-dev/coding/repository-change-publication";
import type { RepositoryChangeState } from "@leitwerk-dev/coding/repository-change-state";
import { gitSshIntegration } from "@leitwerk-dev/git-ssh";
import {
	createGitLabPublicationAdapter,
	type GitLabDeliveryObservation,
	gitlabExternal,
	gitlabIntegration,
	gitlabPublicationEvidenceForRequest,
} from "@leitwerk-dev/gitlab";
import {
	type JiraIssue,
	jiraEligible,
	jiraIntegration,
	jiraIssuePolicy,
	jiraIssueWatcherSource,
} from "@leitwerk-dev/jira";
import { type LeitwerkExtensionModule, scopedSettingsCapability } from "@leitwerk-dev/process-sdk";
import {
	createJiraGitLabLauncher,
	type JiraGitLabParams,
	jiraGitLabParamsCodec,
} from "./launch.js";

export * from "./launch.js";

const namespace = "jiraGitLabChange";
const remote = (state: RepositoryChangeState, key: string) =>
	readPublicationState(state, `${namespace}:${key}`);

/** @public */
export function createJiraGitLabChange(options: {
	/** @internal */
	docker: boolean;
}) {
	const launcher = createJiraGitLabLauncher();
	const sources: PublicationSource<JiraGitLabParams>[] = [
		{
			id: "gitlab_merge_requests",
			kind: "observation",
			label: "GitLab merge request evidence",
			source: gitlabExternal.mergeRequests(({ params, state }) => ({
				repositories: params.repositories.flatMap((repo) => {
					const c = remote(state, repo.key);
					return c.prNumber && c.headSha && !c.delivery.terminalPullRequest
						? [
								{
									projectKey: repo.key,
									origin: repo.gitlabOrigin,
									profile: repo.gitlabProfile,
									projectId: repo.projectId,
									iid: c.prNumber,
									afterKey: c.observationKey,
									pollInterval: "30s",
									feedback: { afterId: c.conversationCursor, quietPeriodMs: 120000 },
									delivery: {
										headSha: c.headSha,
										owner: repo.owner,
										repo: repo.repo,
										headBranch: repo.workBranch,
										baseBranch: repo.baseBranch,
										lastConflictKey: c.lastConflictKey,
									},
								},
							]
						: [];
				}),
			})),
			read({ params, state, event }) {
				const observed = event as GitLabDeliveryObservation;
				const repo = params.repositories.find((repo) => repo.key === observed.projectKey);
				if (
					!repo ||
					observed.mr.project_id !== repo.projectId ||
					observed.mr.source_project_id !== repo.projectId ||
					observed.mr.target_project_id !== repo.projectId ||
					observed.mr.source_branch !== repo.workBranch ||
					observed.mr.target_branch !== repo.baseBranch
				)
					throw new Error("Uncorrelated GitLab repository evidence");
				return {
					...gitlabPublicationEvidenceForRequest(remote(state, repo.key), observed),
					projectKey: repo.key,
				};
			},
		},
		{
			id: "source_cancelled",
			kind: "observation",
			label: "Jira source cancelled",
			source: jiraIssuePolicy(({ params }) => ({
				profile: params.jiraProfile,
				baseUrl: params.jiraBaseUrl,
				issueId: params.issueId,
				mode: "cancelled",
			})),
			read: () => ({ kind: "observed" }),
		},
	];
	const adapter = createGitLabPublicationAdapter(sources, namespace);
	adapter.repositories = (params) =>
		params.repositories.map((repo) => ({
			key: repo.key,
			params: { ...params, ...repo, issueUrl: params.issueUrl },
		}));
	adapter.tools.delivery = [
		...adapter.tools.delivery,
		"jira_get_source_issue",
		"jira_comment",
		"jira_finalize_source_issue",
	];
	adapter.ensureRequest = async (ctx) => {
		const observed = (await ctx.callIntegrationTool("gitlab_ensure_merge_request", {
			projectKey: "repo",
			title: `${ctx.params.issueKey}: ${ctx.params.issue.fields.summary}`,
			body: `Implements ${ctx.params.issueUrl}\n\nLeitwerk process: ${ctx.process.id}`,
		})) as GitLabDeliveryObservation["mr"];
		return {
			number: observed.iid,
			html_url: observed.web_url,
			merged: observed.state === "merged",
			merge_commit_sha: observed.merge_commit_sha,
		};
	};
	adapter.observeTerminal = async (ctx, current) => {
		const project = ctx.projects.find((project) => project.key === ctx.repo.get("repo").key);
		if (!current.prNumber && !(project?.metadata?.gitlab as { iid?: number } | undefined)?.iid)
			return null;
		const { mr } = (await ctx.callIntegrationTool("gitlab_observe_merge_request", {
			projectKey: "repo",
		})) as GitLabDeliveryObservation;
		return mr.state === "opened"
			? null
			: {
					number: mr.iid,
					html_url: mr.web_url,
					merged: mr.state === "merged",
					merge_commit_sha: mr.merge_commit_sha,
				};
	};
	adapter.sourceCancelled = async (ctx) =>
		!jiraEligible(
			(await ctx.callIntegrationTool("jira_get_source_issue", {
				projectKey: ctx.params.repositories[0].key,
			})) as JiraIssue,
		);
	adapter.linkIssue = async (ctx, current) => {
		await ctx.callIntegrationTool("jira_comment", {
			projectKey: "repo",
			body: `Leitwerk opened ${ctx.params.owner}/${ctx.params.repo}: ${current.prUrl}`,
			writeKey: `mr-link:${ctx.params.gitlabProfile}:${ctx.params.projectId}:${current.prNumber}`,
		});
	};
	adapter.reconcileTerminal = async () => {};
	adapter.reconcileAll = async (ctx, results, cancelled) => {
		const created = results.filter(({ current }) => !current.noChanges);
		const merged = created.filter(({ current }) => current.delivery.terminalPullRequest?.merged);
		const done = !cancelled && created.length > 0 && merged.length === created.length;
		const summary = cancelled
			? "Source cancelled. Further delivery stopped; open merge requests remain untouched."
			: !created.length
				? "No repositories changed. No merge requests were needed."
				: done
					? "All merge requests merged."
					: merged.length
						? "Partial result: some merge requests merged and others closed without merge."
						: "Aborted: every merge request closed without merge.";
		const projectKey = ctx.params.repositories[0].key;
		await ctx.callIntegrationTool("jira_comment", {
			projectKey,
			body: `${summary}\n${results.map(({ key, current }) => `${key}: ${current.noChanges ? "no changes" : `${current.prUrl ?? "unpublished"} — ${current.delivery.terminalPullRequest ? (current.delivery.terminalPullRequest.merged ? "merged" : "closed without merge") : "open"}`}`).join("\n")}`,
			writeKey: "delivery-outcome",
		});
		if (!cancelled)
			await ctx.callIntegrationTool("jira_finalize_source_issue", {
				projectKey,
				done,
				writeKey: "delivery-labels",
			});
	};
	const publication = createRepositoryChangePublication(adapter);
	publication.fragment.watcher({
		id: "use_leitwerk",
		label: "Jira use-leitwerk issues",
		description: "Coordinate changes across component-mapped GitLab repositories",
		source: jiraIssueWatcherSource,
		resolveLaunchConfig: launcher.resolve,
		preparationChecks: launcher.checks,
	});
	const { process } = createRepositoryChangeProcess<JiraGitLabParams>({
		processId: "jira_gitlab_change_process",
		displayName: "Jira GitLab Change",
		paramsCodec: jiraGitLabParamsCodec,
		publication,
		workflow: {
			multiRepository: true,
			async planDecision(params) {
				const issue = await launcher.readIssue(params);
				return {
					skip: jiraEligible(issue) && issue.fields.labels.includes("leitwerk-skip-plan-decision"),
					reason: "Jira label",
				};
			},
			async simplification(params) {
				const issue = await launcher.readIssue(params);
				return {
					skip: issue.fields.labels.includes("leitwerk-skip-simplification"),
					reason: "Jira source labels",
				};
			},
			planBypassSource: jiraIssuePolicy(({ params, state }) => ({
				profile: params.jiraProfile,
				baseUrl: params.jiraBaseUrl,
				issueId: params.issueId,
				planRevision: state.routing?.plan?.planRevision,
				mode: "plan_bypass",
			})),
		},
		repositoryCredentials: ({ params }) =>
			params.repositories.map((repo) => ({
				projectKey: repo.key,
				kind: "git_ssh",
				credentialRef: repo.sshProfile,
			})),
	});
	process.runtime = { ...process.runtime, docker: options.docker };
	const extension: LeitwerkExtensionModule = {
		manifest: {
			id: "jira-gitlab-change",
			version: "0.3.0",
			requires: ["jira", "gitlab", "git-ssh", "coding"],
		},
		scopedSettings: { settings: [launcher.mapping] },
		setupCatalog(api) {
			api.registerProcess(process);
		},
		setupServer(api) {
			const jira = api.require(jiraIntegration),
				gitlab = api.require(gitlabIntegration),
				ssh = api.require(gitSshIntegration),
				settings = api.require(scopedSettingsCapability);
			if (
				Array.isArray(jira) ||
				Array.isArray(gitlab) ||
				Array.isArray(ssh) ||
				Array.isArray(settings)
			)
				throw new Error("Integration capabilities must be singular");
			launcher.configure({ jira, gitlab, ssh, settings });
			api.onStop(() => launcher.configure(null));
		},
	};
	return {
		/** @internal */
		extension,
		/** @internal */
		process,
		/** @internal */
		launcher,
	};
}

/** @public */
export const { extension: defaultExtension, process: jiraGitLabChangeProcess } =
	createJiraGitLabChange({ docker: true });
export default defaultExtension;
