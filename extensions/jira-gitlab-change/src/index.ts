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
	type GitLabMergeRequest,
	gitlabExternal,
	gitlabIntegration,
	gitlabPublicationEvidenceForRequest,
	gitlabPublicationSource,
	gitlabRepositoryCredentials,
} from "@leitwerk-dev/gitlab";
import {
	type JiraIssue,
	jiraEligible,
	jiraIntegration,
	jiraIssuePolicy,
	jiraIssueWatcherSource,
	jiraWikiSource,
} from "@leitwerk-dev/jira";
import {
	coreHostCapabilities,
	type LeitwerkExtensionModule,
	scopedSettingsCapability,
} from "@leitwerk-dev/process-sdk";
import { wikiInstructions } from "@leitwerk-dev/wiki";
import { topicWikiCapability } from "@leitwerk-dev/wiki/integration";
import {
	createJiraGitLabLauncher,
	type JiraGitLabParams,
	jiraGitLabParamsCodec,
} from "./launch.js";
import { parseJiraModelLabels } from "./models.js";

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
						? [{ projectKey: repo.key, ...gitlabPublicationSource(repo, c) }]
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
				triggerLabel: params.jiraTriggerLabel,
				mode: "cancelled",
			})),
			read: () => ({ kind: "observed" }),
		},
	];
	const adapter = createGitLabPublicationAdapter(sources, namespace);
	adapter.ensureRequest = async (ctx) => {
		const { url } = (await ctx.callIntegrationTool("jira_ensure_remote_link", {
			projectKey: "repo",
			kind: "process",
		})) as { url: string };
		const mr = (await ctx.callIntegrationTool("gitlab_ensure_merge_request", {
			projectKey: "repo",
			title: `${ctx.params.issueKey}: ${ctx.params.issue.fields.summary}`,
			body: `Implements [${ctx.params.issueKey}](${ctx.params.issueUrl})\n\n[Leitwerk process](${url})`,
		})) as GitLabMergeRequest;
		return {
			number: mr.iid,
			html_url: mr.web_url,
			merged: mr.state === "merged",
			merge_commit_sha: mr.merge_commit_sha,
		};
	};
	adapter.repositories = (params) =>
		params.repositories.map((repo) => ({
			key: repo.key,
			params: { ...params, ...repo, issueUrl: params.issueUrl },
		}));
	adapter.tools.delivery = [
		...adapter.tools.delivery,
		"jira_get_source_issue",
		"jira_ensure_remote_link",
		"jira_transition_source_issue",
		"jira_finalize_source_issue",
	];
	adapter.sourceCancelled = async (ctx) =>
		!jiraEligible(
			(await ctx.callIntegrationTool("jira_get_source_issue", {
				projectKey: ctx.params.repositories[0].key,
			})) as JiraIssue,
			ctx.params.jiraTriggerLabel,
		);
	adapter.linkIssue = async (ctx) => {
		await ctx.callIntegrationTool("jira_ensure_remote_link", {
			projectKey: "repo",
			kind: "merge_request",
		});
	};
	adapter.reconcileTerminal = async () => {};
	adapter.reconcileAll = async (ctx, results, cancelled) => {
		const created = results.filter(({ current }) => !current.noChanges);
		const merged = created.filter(({ current }) => current.delivery.terminalPullRequest?.merged);
		const done = !cancelled && created.length > 0 && merged.length === created.length;
		const projectKey = ctx.params.repositories[0].key;
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
					skip:
						jiraEligible(issue, params.jiraTriggerLabel) &&
						issue.fields.labels.includes("leitwerk-skip-plan-decision"),
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
				triggerLabel: params.jiraTriggerLabel,
				planRevision: state.routing?.plan?.planRevision,
				mode: "plan_bypass",
			})),
		},
		repositoryCredentials: ({ params }) =>
			params.repositories.flatMap((repo) =>
				repo.sshProfile
					? [{ projectKey: repo.key, kind: "git_ssh" as const, credentialRef: repo.sshProfile }]
					: gitlabRepositoryCredentials(repo.gitlabProfile, [repo]),
			),
	});
	process.runtime = { ...process.runtime, docker: options.docker };
	const plan = process.turns.get("generate_plan")?.definition;
	const delivery = process.turns.get("deliver_change")?.definition;
	if (plan?.kind !== "llm" || delivery?.kind !== "automatic")
		throw new Error("Jira change requires planning and delivery turns");
	plan.integrationTools = [
		...(plan.integrationTools ?? []),
		"jira_ensure_remote_link",
		"jira_transition_source_issue",
	];
	const originalPrepare = plan.prepare;
	plan.prepare = async (ctx) => {
		const projectKey = ctx.params.repositories[0].key;
		await ctx.callIntegrationTool("jira_ensure_remote_link", { projectKey, kind: "process" });
		await ctx.callIntegrationTool("jira_transition_source_issue", {
			projectKey,
			targetStatus: "In Progress",
		});
		return (await originalPrepare?.(ctx)) ?? {};
	};
	const originalDelivery = delivery.run;
	delivery.run = async (ctx) => {
		const result = await originalDelivery(ctx);
		if (result.outcome === "aborted") return result;
		const state = process.stateCodec.parse(result.params?.nextState);
		const published = ctx.params.repositories.map((repo) => remote(state, repo.key));
		if (published.some((current) => current.prNumber)) {
			if (!ctx.callIntegrationTool) throw new Error("Jira integration tools are unavailable");
			// Resumed runs may have marked issueLinked while delivery still used Jira comments.
			await ctx.callIntegrationTool("jira_ensure_remote_link", {
				projectKey: ctx.params.repositories[0].key,
				kind: "process",
			});
			for (const [index, current] of published.entries())
				if (current.prNumber && current.prUrl)
					await ctx.callIntegrationTool("jira_ensure_remote_link", {
						projectKey: ctx.params.repositories[index].key,
						kind: "merge_request",
					});
			if (published.every((current) => current.noChanges || (current.prNumber && current.prUrl)))
				await ctx.callIntegrationTool("jira_transition_source_issue", {
					projectKey: ctx.params.repositories[0].key,
					targetStatus: "In Review",
				});
		}
		return result;
	};
	for (const binding of process.turns.values()) {
		const turn = binding.definition;
		if (turn.kind !== "llm") continue;
		const originalPrompt = turn.prompt;
		const originalTools = turn.resolveIntegrationTools;
		turn.resolveIntegrationTools = (params, state) => [
			...(originalTools?.(params, state) ?? turn.integrationTools ?? []),
			...(params.wikiTopicId
				? ["wiki_index", "wiki_read", "wiki_share", "wiki_edit", "wiki_delete", "wiki_delete_group"]
				: []),
		];
		turn.prompt = async (ctx) =>
			`${await originalPrompt(ctx)}${ctx.params.wikiTopicId ? `\n\n${wikiInstructions}\nWiki: /wiki/${ctx.params.wikiTopicId}` : ""}`;
	}
	const extension: LeitwerkExtensionModule = {
		manifest: {
			id: "jira-gitlab-change",
			version: "0.3.0",
			requires: ["jira", "gitlab", "coding"],
		},
		scopedSettings: { settings: [launcher.mapping] },
		setupCatalog(api) {
			api.registerProcess(process);
		},
		setupServer(api, config) {
			adapter.maintenance?.register(api, process);
			const jira = api.require(jiraIntegration),
				gitlab = api.require(gitlabIntegration),
				settings = api.require(scopedSettingsCapability);
			if (Array.isArray(jira) || Array.isArray(gitlab) || Array.isArray(settings))
				throw new Error("Integration capabilities must be singular");
			const wiki = api.require(topicWikiCapability);
			const host = api.require(coreHostCapabilities.serverSetup);
			if (Array.isArray(wiki) || Array.isArray(host))
				throw new Error("Integration capabilities must be singular");
			wiki.registerProcessSource(process.id, jiraWikiSource(wiki, jira));
			launcher.configure({
				modelLabels: parseJiraModelLabels(config),
				jira,
				gitlab,
				get ssh() {
					const ssh = api.get(gitSshIntegration);
					if (Array.isArray(ssh)) throw new Error("Integration capabilities must be singular");
					return ssh;
				},
				settings,
				wiki,
				publications: host.publications,
			});
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
