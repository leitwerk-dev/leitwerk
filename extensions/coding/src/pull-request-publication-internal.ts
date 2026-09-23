import type {
	defineExternalActionSource,
	RepositoryFeedbackSourceConfig,
	RepositoryIssueCancelledSourceConfig,
	RepositoryPullRequestSourceConfig,
} from "@leitwerk-dev/process-sdk";
import type { GitIdentity } from "./finalization-git.js";
import type { RepositoryIssueOriginParams } from "./repository-change-launch-internal.js";
import type {
	PublicationContext,
	PublicationEvidence,
	PublicationParams,
	PublicationRequest,
	PublicationSource,
	PublicationState,
	RepositoryChangePublicationAdapter,
} from "./repository-change-publication.js";
import {
	publicationObject as object,
	readPublicationState,
} from "./repository-change-publication.js";
import type { RepositoryChangeState } from "./repository-change-state.js";

const callFor =
	<P>(ctx: PublicationContext<P>, provider: string) =>
	<T>(name: string, args: Record<string, unknown>) =>
		ctx.callIntegrationTool(`${provider}_${name}`, { projectKey: "repo", ...args }) as Promise<T>;

/** @internal */
export async function resolvePullRequestGitIdentity<P>(
	ctx: PublicationContext<P>,
	provider: string,
	profile: string,
): Promise<GitIdentity> {
	const project = ctx.projects.find((candidate) => candidate.key === "repo");
	const identity = object(object(project?.metadata)["leitwerk.gitIdentity"]);
	if (
		identity.provider === provider &&
		identity.profile === profile &&
		[identity.login, identity.name, identity.email].every(
			(value) => typeof value === "string" && value.trim(),
		)
	)
		return identity as unknown as GitIdentity;
	return callFor(ctx, provider)<GitIdentity>("resolve_git_identity", {});
}

/** @internal */
export function readPullRequestFeedback(
	current: PublicationState,
	event: unknown,
): Extract<PublicationEvidence, { kind: "feedback" }> {
	const value = object(event);
	const cursors = object(value.cursors);
	return {
		kind: "feedback",
		conversationCursor: Number(cursors.conversationCursor ?? current.conversationCursor),
		reviewCursor: Number(cursors.reviewCursor ?? current.reviewCursor),
		inlineCursor: Number(cursors.inlineCursor ?? current.inlineCursor),
		feedbackIds: (value.feedbackIds ?? []) as PublicationState["feedbackIds"],
	};
}

/** @internal */
export function reconcilePullRequestSourceIssue<P extends PublicationParams>(
	provider: string,
	labelKey: "id" | "name",
	issueOrigin: (params: P) =>
		| {
				/** @internal */
				issueNumber: number;
				/** @internal */
				triggerLabel: string;
				/** @internal */
				doneLabel: string;
		  }
		| undefined,
): RepositoryChangePublicationAdapter<P>["reconcileTerminal"] {
	return async (ctx, _current, pr) => {
		const params = issueOrigin(ctx.params);
		if (!params) return;
		const call = callFor(ctx, provider);
		const issue = await call<{ labels: Array<{ id: number; name: string }> }>("get_issue", {
			issueNumber: params.issueNumber,
		});
		let labels = issue.labels
			.filter((label) => label.name !== params.triggerLabel)
			.map((label) => label[labelKey]);
		if (pr.merged) {
			const done = await call<{ id: number; name: string }>("ensure_label", {
				name: params.doneLabel,
			});
			labels = [...new Set([...labels, done[labelKey]])];
		}
		await call("update_issue", {
			issueNumber: params.issueNumber,
			patch: { labels, ...(pr.merged ? { state: "closed" } : {}) },
			writeKey: `${provider}:${ctx.process.id}:${pr.merged ? "complete-source-issue" : "remove-source-trigger"}`,
		});
		await call("add_issue_comment", {
			issueNumber: params.issueNumber,
			body: pr.merged
				? `Merged ${pr.html_url}${pr.merge_commit_sha ? ` at ${pr.merge_commit_sha}` : ""}.`
				: `Leitwerk stopped because ${pr.html_url} was closed without merge.`,
			writeKey: `${provider}:${ctx.process.id}:${pr.merged ? "merged" : "closed"}-pr-comment`,
		});
	};
}

/** @internal */
type SourceFactory<C> = ReturnType<typeof defineExternalActionSource<C>>;

/** Shared wiring for providers implementing the pull-request source protocol. @internal */
export function pullRequestPublicationSources<P extends PublicationParams>(
	provider: string,
	label: string,
	external: {
		/** @internal */
		pullRequestFeedback: SourceFactory<
			Omit<RepositoryFeedbackSourceConfig, "disabled" | "terminalOutcome">
		>;
		/** @internal */
		pullRequestTerminal: SourceFactory<Omit<RepositoryPullRequestSourceConfig, "disabled">>;
		/** @internal */
		issueCancelled: SourceFactory<RepositoryIssueCancelledSourceConfig>;
	},
	profile: (params: P) => string,
	issueOrigin: (params: P) => RepositoryIssueOriginParams | undefined,
) {
	const remote = (state: RepositoryChangeState) =>
		readPublicationState(state, `${provider}RepoChange`);
	/** @internal */
	function requirePr(state: RepositoryChangeState) {
		const value = remote(state);
		if (!value.headSha || !value.prNumber || !value.prUrl)
			throw new Error("Pull request delivery state is incomplete");
		return {
			...value,
			/** @internal */ headSha: value.headSha,
			/** @internal */ prNumber: value.prNumber,
			/** @internal */ prUrl: value.prUrl,
		};
	}
	const feedback: PublicationSource<P> = {
		id: `${provider}_feedback`,
		kind: "feedback",
		label: `${label} pull request feedback`,
		source: external.pullRequestFeedback<P, RepositoryChangeState>(({ params, state }) => ({
			profile: profile(params),
			owner: params.owner,
			repo: params.repo,
			prNumber: requirePr(state).prNumber,
			conversationCursor: remote(state).conversationCursor,
			reviewCursor: remote(state).reviewCursor,
			inlineCursor: remote(state).inlineCursor,
			quietPeriodMs: 120000,
			pollInterval: "30s",
		})),
		read: ({ state, event }) => readPullRequestFeedback(remote(state), event),
	};
	const terminal: PublicationSource<P>[] = (["merged", "closed"] as const).map(
		(terminalOutcome) => ({
			id: `${provider}_pr_${terminalOutcome}`,
			kind: "terminal",
			label: `${label} pull request ${terminalOutcome}`,
			source: external.pullRequestTerminal<P, RepositoryChangeState>(({ params, state }) => ({
				profile: profile(params),
				owner: params.owner,
				repo: params.repo,
				prNumber: requirePr(state).prNumber,
				terminalOutcome,
				pollInterval: "30s",
			})),
			read: ({ event }) => ({
				kind: "terminal",
				request: object(event).pullRequest as PublicationRequest,
			}),
		}),
	);
	const cancelled: PublicationSource<P> = {
		id: "source_cancelled",
		kind: "cancelled",
		label: "Source issue cancelled",
		enabled: (params) => issueOrigin(params) !== undefined,
		source: external.issueCancelled<P, RepositoryChangeState>(({ params }) => {
			const issue = issueOrigin(params);
			if (!issue) throw new Error(`${label} source issue metadata is unavailable`);
			return {
				profile: profile(params),
				owner: params.owner,
				repo: params.repo,
				issueNumber: issue.issueNumber,
				triggerLabel: issue.triggerLabel,
				pollInterval: "30s",
			};
		}),
		read: () => ({ kind: "cancelled" }),
	};
	return {
		/** @internal */ requirePr,
		/** @internal */ feedback,
		/** @internal */ terminal,
		/** @internal */ cancelled,
	};
}

/** Callbacks for providers implementing the shared pull-request tool protocol. @internal */
export function pullRequestPublicationCallbacks<P extends PublicationParams>(
	provider: string,
	label: string,
	issueOrigin: (params: P) =>
		| {
				/** @internal */
				issueNumber: number;
				/** @internal */
				issueUrl: string;
		  }
		| undefined,
): Pick<
	RepositoryChangePublicationAdapter<P>,
	"ensureRequest" | "linkIssue" | "reply" | "acknowledge" | "head" | "afterRebase"
> {
	const call = (ctx: PublicationContext<P>) => callFor(ctx, provider);
	return {
		async ensureRequest(ctx) {
			const project = ctx.repo.get("repo");
			const issue = issueOrigin(ctx.params);
			const pr = await call(ctx)<PublicationRequest>("ensure_pull_request", {
				title: ctx.process.title ?? (issue ? `Issue #${issue.issueNumber}` : "Leitwerk change"),
				body: issue
					? `Implements ${issue.issueUrl}\n\nLeitwerk process: ${ctx.process.id}`
					: `Leitwerk process: ${ctx.process.id}`,
				head: project.workBranch,
				base: project.baseBranch,
			});
			if (!pr) throw new Error(`${label} pull request could not be created or found`);
			return pr;
		},
		async linkIssue(ctx, current) {
			const issue = issueOrigin(ctx.params);
			if (issue)
				await call(ctx)("add_issue_comment", {
					issueNumber: issue.issueNumber,
					body: `Leitwerk opened pull request ${current.prUrl}.`,
					writeKey: `${provider}:${ctx.process.id}:source-pr-link:${current.prNumber}`,
				});
		},
		async reply(ctx, current) {
			const invoke = call(ctx);
			for (const feedback of current.feedbackIds)
				await invoke("reply_to_pull_request_feedback", {
					pullRequestNumber: current.prNumber,
					feedbackKind: feedback.kind,
					feedbackId: feedback.id,
					body: `Addressed in ${current.headSha?.slice(0, 8) ?? "the current revision"}.`,
					writeKey: `${provider}:${ctx.process.id}:feedback-reply:${feedback.kind}:${feedback.id}:${current.headSha}`,
				});
		},
		async acknowledge(ctx, current) {
			const invoke = call(ctx);
			for (const feedback of current.feedbackIds) {
				if (feedback.kind === "review") continue;
				await invoke("add_pull_request_feedback_reaction", {
					pullRequestNumber: current.prNumber,
					feedbackKind: feedback.kind,
					feedbackId: feedback.id,
					writeKey: `${provider}:${ctx.process.id}:feedback-eyes:${feedback.kind}:${feedback.id}`,
				});
			}
		},
		async head(ctx, current) {
			return (
				await call(ctx)<{ head: { sha: string } }>("get_pull_request", {
					pullRequestNumber: current.prNumber,
				})
			).head.sha;
		},
		async afterRebase(ctx, current) {
			await call(ctx)("add_pull_request_comment", {
				pullRequestNumber: current.prNumber,
				body: `Merge conflict repair completed at ${current.headSha}; base ${current.conflict?.baseSha}.`,
				writeKey: `rebase:${ctx.process.id}:${current.lastConflictKey}:${current.headSha}`,
			});
		},
	};
}
