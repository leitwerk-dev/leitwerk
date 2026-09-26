import { createRepositoryChangeProcess } from "@leitwerk-dev/coding";
import {
	createRepositoryChangePublication,
	publicationObject as object,
	type PublicationContext,
	type PublicationSource,
	type PublicationState,
	readPublicationState,
} from "@leitwerk-dev/coding/repository-change-publication";
import type { RepositoryChangeState } from "@leitwerk-dev/coding/repository-change-state";
import {
	type GitHubGitIdentity,
	type GitHubPullRequest,
	githubExternal,
	githubIssueWatcherSource,
} from "@leitwerk-dev/github";
import type { FlowAutomaticRunContext } from "@leitwerk-dev/process-sdk";
import {
	type createGitHubRepoChangeLauncher,
	githubRepoChangeLaunchConfig,
	githubRepoChangeParams,
} from "./launcher.js";
import {
	type GitHubIssueOriginParams,
	type GitHubRepoChangeParams,
	githubRepoChangeParamsCodec,
	isIssueOrigin,
} from "./params.js";

const processId = "github_repo_change_process";
const ids = {
	deliver: "deliver_change",
	feedback: "revise_from_pull_request_feedback",
	ciRepair: "repair_github_checks",
	operator: "ci_operator_action",
};
const remote = (state: RepositoryChangeState) => readPublicationState(state, "githubRepoChange");
function requirePr(state: RepositoryChangeState) {
	const value = remote(state);
	if (!value.headSha || !value.prNumber || !value.prUrl)
		throw new Error("Pull request delivery state is incomplete");
	return { ...value, headSha: value.headSha, prNumber: value.prNumber, prUrl: value.prUrl };
}
const feedbackKey = (value: { kind: string; id: number }) => `${value.kind}:${value.id}`;
const callFor =
	(ctx: PublicationContext<GitHubRepoChangeParams>) =>
	<T>(name: string, args: Record<string, unknown>) =>
		ctx.callIntegrationTool(name, { projectKey: "repo", ...args }) as Promise<T>;
function requireIssueOrigin(
	params: GitHubRepoChangeParams,
): GitHubRepoChangeParams & GitHubIssueOriginParams {
	if (!isIssueOrigin(params)) throw new Error("GitHub source issue metadata is unavailable");
	return params;
}

function pinnedGitIdentity(
	ctx: FlowAutomaticRunContext<GitHubRepoChangeParams, RepositoryChangeState>,
): GitHubGitIdentity | null {
	const project = ctx.projects.find((candidate) => candidate.key === "repo");
	const candidate = object(project?.metadata)?.["leitwerk.gitIdentity"];
	const identity = object(candidate);
	if (
		identity.provider !== "github" ||
		identity.profile !== ctx.params.githubProfile ||
		typeof identity.login !== "string" ||
		!identity.login.trim() ||
		typeof identity.name !== "string" ||
		!identity.name.trim() ||
		typeof identity.email !== "string" ||
		!identity.email.trim()
	) {
		return null;
	}
	return identity as unknown as GitHubGitIdentity;
}

const deliveryTools = [
	"github_get_pull_request",
	"github_add_pull_request_comment",
	"github_resolve_git_identity",
	"github_ensure_pull_request",
	"github_add_issue_comment",
	"github_add_pull_request_feedback_reaction",
	"github_reply_to_pull_request_feedback",
	"github_get_issue",
	"github_ensure_label",
	"github_update_issue",
] as const;

/** @public */
export function createGitHubRepoChangeProcess(
	launcher: ReturnType<typeof createGitHubRepoChangeLauncher>,
	docker: boolean,
) {
	const failedPipeline = githubExternal.checks<GitHubRepoChangeParams, RepositoryChangeState>(
		({ params, state }) => ({
			profile: params.githubProfile,
			owner: params.owner,
			repo: params.repo,
			prNumber: requirePr(state).prNumber,
			headSha: requirePr(state).headSha,
			afterKey: remote(state).pipeline?.evidenceKey as string | undefined,
		}),
	);

	const sources: PublicationSource<GitHubRepoChangeParams>[] = [
		{
			id: "github_merge_conflict",
			kind: "conflict",
			label: "Rebase conflicting pull request",
			source: githubExternal.pullRequestState(({ params, state }) => ({
				profile: params.githubProfile,
				owner: params.owner,
				repo: params.repo,
				prNumber: requirePr(state).prNumber,
				headSha: requirePr(state).headSha,
				lastConflictKey: remote(state).lastConflictKey,
				feedbackCursor: 0,
				eventKinds: ["merge_conflict"],
				pollInterval: "30s",
			})),
			read: ({ event }) => ({
				kind: "conflict",
				conflict: object(event).conflict as NonNullable<PublicationState["conflict"]>,
			}),
		},
		{
			id: "github_feedback",
			kind: "feedback",
			label: "GitHub pull request feedback",
			source: githubExternal.pullRequestFeedback(({ params, state }) => ({
				profile: params.githubProfile,
				owner: params.owner,
				repo: params.repo,
				prNumber: requirePr(state).prNumber,
				conversationCursor: remote(state).conversationCursor,
				reviewCursor: remote(state).reviewCursor,
				inlineCursor: remote(state).inlineCursor,
				quietPeriodMs: 120000,
				pollInterval: "30s",
			})),
			read: ({ state, event }) => {
				const value = object(event);
				const cursors = object(value.cursors);
				const current = remote(state);
				return {
					kind: "feedback",
					conversationCursor: Number(cursors.conversationCursor ?? current.conversationCursor),
					reviewCursor: Number(cursors.reviewCursor ?? current.reviewCursor),
					inlineCursor: Number(cursors.inlineCursor ?? current.inlineCursor),
					feedbackIds: (value.feedbackIds ?? []) as PublicationState["feedbackIds"],
				};
			},
		},
		{
			id: "github_failure_repair",
			operatorId: "github_failure_operator",
			kind: "failure",
			label: "Repair failed GitHub checks",
			source: failedPipeline,
			read: ({ state, event }) => {
				const checks = object(object(event).checks);
				const current = requirePr(state);
				if (checks.headSha !== current.headSha) throw new Error("Stale GitHub check evidence");
				const failed = Array.isArray(checks.failed) ? checks.failed : [];
				return {
					kind: "failure",
					pipeline: {
						number: 0,
						status: "failure",
						...checks,
						evidenceKey: `${checks.headSha}:${failed.map((run) => object(run).url).join(":")}`,
					},
				};
			},
		},
		...(["merged", "closed"] as const).map((terminalOutcome) => ({
			id: `github_pr_${terminalOutcome}`,
			kind: "terminal" as const,
			label: `GitHub pull request ${terminalOutcome}`,
			source: githubExternal.pullRequestTerminal<GitHubRepoChangeParams, RepositoryChangeState>(
				({ params, state }) => ({
					profile: params.githubProfile,
					owner: params.owner,
					repo: params.repo,
					prNumber: requirePr(state).prNumber,
					terminalOutcome,
					pollInterval: "30s",
				}),
			),
			read: ({ event }: { event: unknown }) => ({
				kind: "terminal" as const,
				request: object(event).pullRequest as GitHubPullRequest,
			}),
		})),
		{
			id: "source_cancelled",
			kind: "cancelled",
			label: "Source issue cancelled",
			enabled: isIssueOrigin,
			source: githubExternal.issueCancelled(({ params }) => {
				const issue = requireIssueOrigin(params);
				return {
					profile: issue.githubProfile,
					owner: issue.owner,
					repo: issue.repo,
					issueNumber: issue.issueNumber,
					triggerLabel: issue.triggerLabel,
					pollInterval: "30s",
				};
			}),
			read: () => ({ kind: "cancelled" }),
		},
	];
	const publicationConfig = createRepositoryChangePublication<GitHubRepoChangeParams>({
		namespace: "githubRepoChange",
		label: "GitHub PR",
		ids,
		sources,
		tools: {
			delivery: deliveryTools,
			feedback: ["github_get_pull_request", "github_list_pull_request_feedback"],
			ci: ["github_get_ci_diagnostics"],
		},
		async identity(ctx) {
			return (
				pinnedGitIdentity(ctx) ??
				(await callFor(ctx)<GitHubGitIdentity>("github_resolve_git_identity", {}))
			);
		},
		async reconcileTerminal(ctx, _current, pr) {
			const call = callFor(ctx);
			if (isIssueOrigin(ctx.params)) {
				const issue = await call<{
					labels: Array<{ name: string }>;
				}>("github_get_issue", {
					issueNumber: ctx.params.issueNumber,
				});
				let labels = issue.labels
					.filter((label) => label.name !== ctx.params.triggerLabel)
					.map((label) => label.name);
				if (pr.merged) {
					const done = await call<{ name: string }>("github_ensure_label", {
						name: ctx.params.doneLabel,
					});
					labels = [...new Set([...labels, done.name])];
				}
				await call("github_update_issue", {
					issueNumber: ctx.params.issueNumber,
					patch: { labels, ...(pr.merged ? { state: "closed" } : {}) },
					writeKey: `github:${ctx.process.id}:${pr.merged ? "complete-source-issue" : "remove-source-trigger"}`,
				});
				await call("github_add_issue_comment", {
					issueNumber: ctx.params.issueNumber,
					body: pr.merged
						? `Merged ${pr.html_url}${pr.merge_commit_sha ? ` at ${pr.merge_commit_sha}` : ""}.`
						: `Leitwerk stopped because ${pr.html_url} was closed without merge.`,
					writeKey: `github:${ctx.process.id}:${pr.merged ? "merged" : "closed"}-pr-comment`,
				});
			}
		},
		async ensureRequest(ctx) {
			const call = callFor(ctx);
			const project = ctx.repo.get("repo");
			const issueOrigin = isIssueOrigin(ctx.params);
			const pr = await call<GitHubPullRequest>("github_ensure_pull_request", {
				title:
					ctx.process.title ??
					(issueOrigin ? `Issue #${ctx.params.issueNumber}` : "Leitwerk change"),
				body: issueOrigin
					? `Implements ${ctx.params.issueUrl}\n\nLeitwerk process: ${ctx.process.id}`
					: `Leitwerk process: ${ctx.process.id}`,
				head: project.workBranch,
				base: project.baseBranch,
			});
			if (!pr) throw new Error("GitHub pull request could not be created or found");
			return pr;
		},
		async linkIssue(ctx, current) {
			const call = callFor(ctx);
			if (isIssueOrigin(ctx.params)) {
				await call("github_add_issue_comment", {
					issueNumber: ctx.params.issueNumber,
					body: `Leitwerk opened pull request ${current.prUrl}.`,
					writeKey: `github:${ctx.process.id}:source-pr-link:${current.prNumber}`,
				});
			}
		},
		async reply(ctx, current) {
			const call = callFor(ctx);
			for (const feedback of current.feedbackIds) {
				await call("github_reply_to_pull_request_feedback", {
					pullRequestNumber: current.prNumber,
					feedbackKind: feedback.kind,
					feedbackId: feedback.id,
					body: `Addressed in ${current.headSha?.slice(0, 8) ?? "the current revision"}.`,
					writeKey: `github:${ctx.process.id}:feedback-reply:${feedbackKey(feedback)}:${current.headSha}`,
				});
			}
		},
		async acknowledge(ctx, current) {
			const call = callFor(ctx);
			for (const feedback of current.feedbackIds) {
				if (feedback.kind === "review") continue;
				await call("github_add_pull_request_feedback_reaction", {
					pullRequestNumber: current.prNumber,
					feedbackKind: feedback.kind,
					feedbackId: feedback.id,
					writeKey: `github:${ctx.process.id}:feedback-eyes:${feedbackKey(feedback)}`,
				});
			}
		},
		async head(ctx, current) {
			return (
				await callFor(ctx)<GitHubPullRequest>("github_get_pull_request", {
					pullRequestNumber: current.prNumber,
				})
			).head.sha;
		},
		async afterRebase(ctx, current) {
			await callFor(ctx)("github_add_pull_request_comment", {
				pullRequestNumber: current.prNumber,
				body: `Merge conflict repair completed at ${current.headSha}; base ${current.conflict?.baseSha}.`,
				writeKey: `rebase:${ctx.process.id}:${current.lastConflictKey}:${current.headSha}`,
			});
		},
		commitMessage: (kind) =>
			kind === "feedback" ? "fix: address GitHub review feedback" : "fix: repair GitHub checks",
		prompt(kind, current) {
			return kind === "feedback"
				? `Address the unseen GitHub pull-request feedback batch for PR #${current.prNumber}. Feedback identifiers: ${JSON.stringify(current.feedbackIds)}. Inspect the current checkout and use GitHub tools to read the full feedback. Do not rely on an earlier plan or conversation. Make only justified repository changes. Call changes_ready if files need publishing, no_changes after an explicit diagnosis that no repository change is needed, or cannot_repair when operator action is required.`
				: `Diagnose failed GitHub checks for request #${current.prNumber}, head ${current.headSha}. Use github_get_ci_diagnostics with pullRequestNumber and headSha to inspect failed check annotations and bounded Actions job logs before changing anything. Fix repository causes. Call changes_ready for repository changes, no_changes only after an explicit provider restart or a justified diagnosis that no repository change is needed, or cannot_repair when operator action is required.`;
		},
	});
	const publication = publicationConfig.fragment;
	publication.watcher({
		id: "use_leitwerk",
		label: "GitHub use-leitwerk issues",
		description: "Launch a remote repository change for GitHub issues carrying the trigger label",
		source: githubIssueWatcherSource,
		preparationChecks: launcher.preparationChecks,
		async resolveLaunchConfig({ profile, repository, issue, labels }) {
			const issueNumber = issue.number;
			const title = issue.title.trim();
			const body = issue.body?.trim() ?? "";
			const issueUrl = issue.html_url;
			const binding = launcher.resolveProfiles(profile);
			const gitIdentity = await launcher.resolveGitIdentity(profile);
			const params: GitHubRepoChangeParams = {
				...githubRepoChangeParams(repository, {
					...binding,
					profile,
					workBranch: `leitwerk/issue-${issueNumber}`,
					prompt: `${title}${body ? `\n\n${body}` : ""}`,
				}),
				origin: "issue",
				issueNumber,
				issueUrl,
				triggerLabel: labels.trigger,
				doneLabel: labels.done,
			};
			return githubRepoChangeLaunchConfig(params, title, gitIdentity, repository);
		},
	});

	const definition = createRepositoryChangeProcess<GitHubRepoChangeParams>({
		processId,
		displayName: "GitHub Repo Change",
		paramsCodec: githubRepoChangeParamsCodec,
		launcher: launcher.launcher,
		finalizeLabel: "Publish pull request",
		finalizeForm: {
			id: "github_publish",
			title: "Publish pull request",
			fields: [],
			submitLabel: "Publish",
		},
		repositoryCredentials: ({ params }) => [
			{
				projectKey: "repo",
				kind: "git_ssh",
				credentialRef: params.sshCredentialRef,
			},
		],
		publication: publicationConfig,
	});

	definition.process.runtime = { ...definition.process.runtime, docker };

	return definition.process;
}
