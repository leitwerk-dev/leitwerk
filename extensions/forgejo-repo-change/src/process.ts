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
	type ForgejoGitIdentity,
	type ForgejoPullRequest,
	forgejoExternal,
	forgejoIssueWatcherSource,
} from "@leitwerk-dev/forgejo";
import type { FlowAutomaticRunContext } from "@leitwerk-dev/process-sdk";
import { woodpeckerExternal } from "@leitwerk-dev/woodpecker";
import {
	type createForgejoRepoChangeLauncher,
	forgejoRepoChangeLaunchConfig,
	forgejoRepoChangeParams,
} from "./launcher.js";
import {
	type ForgejoIssueOriginParams,
	type ForgejoRepoChangeParams,
	forgejoRepoChangeParamsCodec,
	isIssueOrigin,
} from "./params.js";

const processId = "forgejo_repo_change_process";
const ids = {
	deliver: "deliver_change",
	feedback: "revise_from_pull_request_feedback",
	ciRepair: "repair_woodpecker_pipeline",
	operator: "ci_operator_action",
};
const remote = (state: RepositoryChangeState) => readPublicationState(state, "forgejoRepoChange");
function requirePr(state: RepositoryChangeState) {
	const value = remote(state);
	if (!value.headSha || !value.prNumber || !value.prUrl)
		throw new Error("Pull request delivery state is incomplete");
	return { ...value, headSha: value.headSha, prNumber: value.prNumber, prUrl: value.prUrl };
}
const feedbackKey = (value: { kind: string; id: number }) => `${value.kind}:${value.id}`;
const callFor =
	(ctx: PublicationContext<ForgejoRepoChangeParams>) =>
	<T>(name: string, args: Record<string, unknown>) =>
		ctx.callIntegrationTool(name, { projectKey: "repo", ...args }) as Promise<T>;
function requireIssueOrigin(
	params: ForgejoRepoChangeParams,
): ForgejoRepoChangeParams & ForgejoIssueOriginParams {
	if (!isIssueOrigin(params)) throw new Error("Forgejo source issue metadata is unavailable");
	return params;
}

function pinnedGitIdentity(
	ctx: FlowAutomaticRunContext<ForgejoRepoChangeParams, RepositoryChangeState>,
): ForgejoGitIdentity | null {
	const project = ctx.projects.find((candidate) => candidate.key === "repo");
	const candidate = object(project?.metadata)?.["leitwerk.gitIdentity"];
	const identity = object(candidate);
	if (
		identity.provider !== "forgejo" ||
		identity.profile !== ctx.params.forgejoProfile ||
		typeof identity.login !== "string" ||
		!identity.login.trim() ||
		typeof identity.name !== "string" ||
		!identity.name.trim() ||
		typeof identity.email !== "string" ||
		!identity.email.trim()
	) {
		return null;
	}
	return identity as unknown as ForgejoGitIdentity;
}

const deliveryTools = [
	"forgejo_get_pull_request",
	"forgejo_add_pull_request_comment",
	"forgejo_resolve_git_identity",
	"forgejo_ensure_pull_request",
	"forgejo_add_issue_comment",
	"forgejo_add_pull_request_feedback_reaction",
	"forgejo_reply_to_pull_request_feedback",
	"forgejo_get_issue",
	"forgejo_ensure_label",
	"forgejo_update_issue",
] as const;

/** @internal */
export function createForgejoRepoChangeProcess(
	launcher: ReturnType<typeof createForgejoRepoChangeLauncher>,
	docker: boolean,
) {
	const failedPipeline = woodpeckerExternal.pipeline<
		ForgejoRepoChangeParams,
		RepositoryChangeState
	>(({ params, state }) => {
		const current = requirePr(state);
		return {
			profile: params.woodpeckerProfile,
			owner: params.owner,
			repo: params.repo,
			branch: params.workBranch,
			headSha: current.headSha,
			afterPipelineNumber: current.pipeline?.number ?? 0,
			statuses: ["failure", "error", "killed", "canceled", "cancelled", "declined", "blocked"],
			pollInterval: "30s",
		};
	});

	const sources: PublicationSource<ForgejoRepoChangeParams>[] = [
		{
			id: "forgejo_merge_conflict",
			kind: "conflict",
			label: "Rebase conflicting pull request",
			source: forgejoExternal.pullRequestConflict(({ params, state }) => ({
				profile: params.forgejoProfile,
				owner: params.owner,
				repo: params.repo,
				prNumber: requirePr(state).prNumber,
				headSha: requirePr(state).headSha,
				lastConflictKey: remote(state).lastConflictKey,
				pollInterval: "30s",
			})),
			read: ({ event }) => ({
				kind: "conflict",
				conflict: object(event).conflict as NonNullable<PublicationState["conflict"]>,
			}),
		},
		{
			id: "forgejo_feedback",
			kind: "feedback",
			label: "Forgejo pull request feedback",
			source: forgejoExternal.pullRequestFeedback(({ params, state }) => ({
				profile: params.forgejoProfile,
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
			id: "woodpecker_failure_repair",
			operatorId: "woodpecker_failure_operator",
			kind: "failure",
			label: "Repair failed Woodpecker pipeline",
			source: failedPipeline,
			read: ({ event }) => ({
				kind: "failure",
				pipeline: object(event).pipeline as NonNullable<PublicationState["pipeline"]>,
			}),
		},
		...(["merged", "closed"] as const).map((terminalOutcome) => ({
			id: `forgejo_pr_${terminalOutcome}`,
			kind: "terminal" as const,
			label: `Forgejo pull request ${terminalOutcome}`,
			source: forgejoExternal.pullRequestTerminal<ForgejoRepoChangeParams, RepositoryChangeState>(
				({ params, state }) => ({
					profile: params.forgejoProfile,
					owner: params.owner,
					repo: params.repo,
					prNumber: requirePr(state).prNumber,
					terminalOutcome,
					pollInterval: "30s",
				}),
			),
			read: ({ event }: { event: unknown }) => ({
				kind: "terminal" as const,
				request: object(event).pullRequest as ForgejoPullRequest,
			}),
		})),
		{
			id: "source_cancelled",
			kind: "cancelled",
			label: "Source issue cancelled",
			enabled: isIssueOrigin,
			source: forgejoExternal.issueCancelled(({ params }) => {
				const issue = requireIssueOrigin(params);
				return {
					profile: issue.forgejoProfile,
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
	const publicationConfig = createRepositoryChangePublication<ForgejoRepoChangeParams>({
		namespace: "forgejoRepoChange",
		label: "Forgejo PR",
		ids,
		sources,
		tools: {
			delivery: deliveryTools,
			feedback: ["forgejo_get_pull_request", "forgejo_list_pull_request_feedback"],
			ci: [
				"woodpecker_lookup_repository",
				"woodpecker_list_pipelines",
				"woodpecker_get_pipeline",
				"woodpecker_get_step_logs",
				"woodpecker_restart_pipeline",
			],
		},
		async identity(ctx) {
			return (
				pinnedGitIdentity(ctx) ??
				(await callFor(ctx)<ForgejoGitIdentity>("forgejo_resolve_git_identity", {}))
			);
		},
		async reconcileTerminal(ctx, _current, pr) {
			const call = callFor(ctx);
			if (isIssueOrigin(ctx.params)) {
				const issue = await call<{
					labels: Array<{ id: number; name: string }>;
				}>("forgejo_get_issue", {
					issueNumber: ctx.params.issueNumber,
				});
				let labels = issue.labels
					.filter((label) => label.name !== ctx.params.triggerLabel)
					.map((label) => label.id);
				if (pr.merged) {
					const done = await call<{ id: number }>("forgejo_ensure_label", {
						name: ctx.params.doneLabel,
					});
					labels = [...new Set([...labels, done.id])];
				}
				await call("forgejo_update_issue", {
					issueNumber: ctx.params.issueNumber,
					patch: { labels, ...(pr.merged ? { state: "closed" } : {}) },
					writeKey: `forgejo:${ctx.process.id}:${pr.merged ? "complete-source-issue" : "remove-source-trigger"}`,
				});
				await call("forgejo_add_issue_comment", {
					issueNumber: ctx.params.issueNumber,
					body: pr.merged
						? `Merged ${pr.html_url}${pr.merge_commit_sha ? ` at ${pr.merge_commit_sha}` : ""}.`
						: `Leitwerk stopped because ${pr.html_url} was closed without merge.`,
					writeKey: `forgejo:${ctx.process.id}:${pr.merged ? "merged" : "closed"}-pr-comment`,
				});
			}
		},
		async ensureRequest(ctx) {
			const call = callFor(ctx);
			const project = ctx.repo.get("repo");
			const issueOrigin = isIssueOrigin(ctx.params);
			const pr = await call<ForgejoPullRequest>("forgejo_ensure_pull_request", {
				title:
					ctx.process.title ??
					(issueOrigin ? `Issue #${ctx.params.issueNumber}` : "Leitwerk change"),
				body: issueOrigin
					? `Implements ${ctx.params.issueUrl}\n\nLeitwerk process: ${ctx.process.id}`
					: `Leitwerk process: ${ctx.process.id}`,
				head: project.workBranch,
				base: project.baseBranch,
			});
			if (!pr) throw new Error("Forgejo pull request could not be created or found");
			return pr;
		},
		async linkIssue(ctx, current) {
			const call = callFor(ctx);
			if (isIssueOrigin(ctx.params)) {
				await call("forgejo_add_issue_comment", {
					issueNumber: ctx.params.issueNumber,
					body: `Leitwerk opened pull request ${current.prUrl}.`,
					writeKey: `forgejo:${ctx.process.id}:source-pr-link:${current.prNumber}`,
				});
			}
		},
		async reply(ctx, current) {
			const call = callFor(ctx);
			for (const feedback of current.feedbackIds) {
				await call("forgejo_reply_to_pull_request_feedback", {
					pullRequestNumber: current.prNumber,
					feedbackKind: feedback.kind,
					feedbackId: feedback.id,
					body: `Addressed in ${current.headSha?.slice(0, 8) ?? "the current revision"}.`,
					writeKey: `forgejo:${ctx.process.id}:feedback-reply:${feedbackKey(feedback)}:${current.headSha}`,
				});
			}
		},
		async acknowledge(ctx, current) {
			const call = callFor(ctx);
			for (const feedback of current.feedbackIds) {
				if (feedback.kind === "review") continue;
				await call("forgejo_add_pull_request_feedback_reaction", {
					pullRequestNumber: current.prNumber,
					feedbackKind: feedback.kind,
					feedbackId: feedback.id,
					writeKey: `forgejo:${ctx.process.id}:feedback-eyes:${feedbackKey(feedback)}`,
				});
			}
		},
		async head(ctx, current) {
			return (
				await callFor(ctx)<ForgejoPullRequest>("forgejo_get_pull_request", {
					pullRequestNumber: current.prNumber,
				})
			).head.sha;
		},
		async afterRebase(ctx, current) {
			await callFor(ctx)("forgejo_add_pull_request_comment", {
				pullRequestNumber: current.prNumber,
				body: `Merge conflict repair completed at ${current.headSha}; base ${current.conflict?.baseSha}.`,
				writeKey: `rebase:${ctx.process.id}:${current.lastConflictKey}:${current.headSha}`,
			});
		},
		commitMessage: (kind) =>
			kind === "feedback"
				? "fix: address Forgejo review feedback"
				: "fix: repair Woodpecker pipeline",
		prompt(kind, current) {
			return kind === "feedback"
				? `Address the unseen Forgejo pull-request feedback batch for PR #${current.prNumber}. Feedback identifiers: ${JSON.stringify(current.feedbackIds)}. Inspect the current checkout and use Forgejo tools to read the full feedback. Do not rely on an earlier plan or conversation. Make only justified repository changes. Call changes_ready if files need publishing, no_changes after an explicit diagnosis that no repository change is needed, or cannot_repair when operator action is required.`
				: `Diagnose Woodpecker pipeline #${current.pipeline?.number ?? "unknown"} (${current.pipeline?.status ?? "unknown"}) for the current checkout. Use Woodpecker tools to inspect pipeline metadata and bounded failed-step logs before changing anything. Fix repository causes. Call changes_ready for repository changes, no_changes only after an explicit provider restart or a justified diagnosis that no repository change is needed, or cannot_repair when operator action is required.`;
		},
	});
	const publication = publicationConfig.fragment;
	publication.watcher({
		id: "use_leitwerk",
		label: "Forgejo use-leitwerk issues",
		description: "Launch a remote repository change for Forgejo issues carrying the trigger label",
		source: forgejoIssueWatcherSource,
		preparationChecks: launcher.preparationChecks,
		async resolveLaunchConfig({ profile, repository, issue, labels }) {
			const issueNumber = issue.number;
			const title = issue.title.trim();
			const body = issue.body?.trim() ?? "";
			const issueUrl = issue.html_url;
			const binding = launcher.resolveProfiles(profile);
			const gitIdentity = await launcher.resolveGitIdentity(profile);
			const params: ForgejoRepoChangeParams = {
				...forgejoRepoChangeParams(repository, {
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
			return forgejoRepoChangeLaunchConfig(params, title, gitIdentity);
		},
	});

	const definition = createRepositoryChangeProcess<ForgejoRepoChangeParams>({
		processId,
		displayName: "Forgejo Repo Change",
		paramsCodec: forgejoRepoChangeParamsCodec,
		launcher: launcher.launcher,
		finalizeLabel: "Publish pull request",
		finalizeForm: {
			id: "forgejo_publish",
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
