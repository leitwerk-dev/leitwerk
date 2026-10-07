import {
	type PublicationContext,
	type PublicationEvidence,
	type PublicationParams,
	type PublicationRequest,
	type PublicationSource,
	type PublicationState,
	type RepositoryChangePublicationAdapter,
	resolvePullRequestGitIdentity,
} from "@leitwerk-dev/coding/repository-change-publication";
import type { GitLabMergeRequest } from "./client.js";
import type { GitLabDeliveryObservation, GitLabSourceConfig } from "./external.js";
import { gitlabMaintenanceSource } from "./maintenance.js";
import { registerGitLabPublicationMaintenance } from "./publication-maintenance.js";

/** @public */
export interface GitLabPublicationParams extends PublicationParams {
	/** @internal */
	gitlabProfile: string;

	/** @internal */
	projectId: number;

	/** @internal */
	origin: string;

	/** @internal */
	issueNumber?: number | null;

	/** @internal */
	issueUrl?: string | null;

	/** @internal */
	triggerLabel?: string | null;

	/** @internal */
	doneLabel?: string | null;
}
/** @internal */
export const gitlabPublicationRequest = (mr: GitLabMergeRequest): PublicationRequest => ({
	number: mr.iid,
	html_url: mr.web_url,
	merged: mr.state === "merged",
	merge_commit_sha: mr.merge_commit_sha,
});
const callFor =
	(ctx: PublicationContext<GitLabPublicationParams>) =>
	<T>(name: string, args: Record<string, unknown> = {}) =>
		ctx.callIntegrationTool(name, { projectKey: "repo", ...args }) as Promise<T>;

/** Shared observation policy for direct and coordinated GitLab delivery. @internal */
export function gitlabPublicationSource(
	params: GitLabPublicationParams & {
		/** @internal */
		gitlabOrigin: string;
	},
	current: PublicationState,
): GitLabSourceConfig {
	if (!current.prNumber || !current.headSha)
		throw new Error("Merge request delivery state is incomplete");
	return {
		profile: params.gitlabProfile,
		origin: params.gitlabOrigin,
		projectId: params.projectId,
		iid: current.prNumber,
		pollInterval: "30s",
		afterKey: current.observationKey,
		feedback: { afterId: current.conversationCursor, quietPeriodMs: 120000 },
		delivery: {
			headSha: current.headSha,
			owner: params.owner,
			repo: params.repo,
			headBranch: params.workBranch,
			baseBranch: params.baseBranch,
			lastConflictKey: current.lastConflictKey,
		},
	};
}

/** @public */
export function gitlabPublicationEvidenceForRequest(
	state: PublicationState,
	event: GitLabDeliveryObservation,
): PublicationEvidence {
	const current = state;
	if (!current.prNumber || !current.headSha)
		throw new Error("Merge request delivery state is incomplete");
	const key = { observationKey: event.observationKey };
	if (event.mr.iid !== current.prNumber) throw new Error("Stale GitLab merge request evidence");
	if (event.mr.state === "merged" || event.mr.state === "closed")
		return { kind: "terminal", request: gitlabPublicationRequest(event.mr), ...key };
	if (event.mr.sha !== current.headSha) return { kind: "observed", ...key };
	if (event.conflict) return { kind: "conflict", conflict: event.conflict, ...key };
	if (event.feedback?.length)
		return {
			kind: "feedback",
			// Leave concurrent CI evidence available after feedback that needs no code change.
			feedbackIds: event.feedback.map((n) => ({
				kind: "inline",
				id: n.id,
				discussionId: n.discussionId,
			})),
			conversationCursor: Math.max(current.conversationCursor, ...event.feedback.map((n) => n.id)),
			reviewCursor: 0,
			inlineCursor: 0,
		};
	if (event.pipeline?.status === "failed")
		return { kind: "failure", pipeline: { ...event.pipeline, number: event.pipeline.id }, ...key };
	return { kind: "observed", ...key };
}
/** Shared GitLab publication and repair operations. @public */
export function createGitLabPublicationAdapter<P extends GitLabPublicationParams>(
	sources: PublicationSource<P>[],
	namespace = "gitlabRepoChange",
	describeRequest = (ctx: PublicationContext<P>) => ({
		/** @internal */
		title: ctx.process.title ?? "Leitwerk change",
		/** @internal */
		body: `${ctx.params.origin === "issue" ? `Implements ${ctx.params.issueUrl}\n\n` : ""}Leitwerk process: ${ctx.process.id}`,
	}),
): RepositoryChangePublicationAdapter<P> {
	async function finalizeIssue(ctx: PublicationContext<P>, pr: PublicationRequest | null) {
		if (ctx.params.origin !== "issue") return;
		const call = callFor(ctx);
		await call("gitlab_finalize_source_issue", {
			issueNumber: ctx.params.issueNumber,
			merged: pr?.merged ?? false,
			triggerLabel: ctx.params.triggerLabel,
			doneLabel: ctx.params.doneLabel,
			writeKey: `gitlab:${ctx.process.id}:${pr?.merged ? "complete-source-issue" : pr ? "remove-source-trigger" : "no-changes-trigger"}`,
		});
		await call("gitlab_add_issue_comment", {
			issueNumber: ctx.params.issueNumber,
			body: !pr
				? "No repository changes were needed. No merge request was opened."
				: pr.merged
					? `Merged ${pr.html_url}${pr.merge_commit_sha ? ` at ${pr.merge_commit_sha}` : ""}.`
					: `Leitwerk stopped because ${pr.html_url} was closed without merge.`,
			writeKey: `gitlab:${ctx.process.id}:${pr ? `${pr.merged ? "merged" : "closed"}-mr-comment` : "no-changes-comment"}`,
		});
	}
	const adapter: RepositoryChangePublicationAdapter<P> = {
		maintenance: {
			source: gitlabMaintenanceSource(),
			ownershipTool: "gitlab_assert_maintenance",
			register: (api, process) => registerGitLabPublicationMaintenance(api, process, adapter),
		},
		namespace,
		label: "GitLab MR",
		ids: {
			deliver: "deliver_change",
			feedback: "revise_from_merge_request_feedback",
			ciRepair: "repair_gitlab_pipeline",
			operator: "ci_operator_action",
		},
		sources,
		tools: {
			delivery: [
				"gitlab_assert_maintenance",
				"gitlab_ensure_merge_request",
				"gitlab_observe_merge_request",
				"gitlab_comment",
				"gitlab_reply",
				"gitlab_get_identity",
				"gitlab_acknowledge_feedback",
				"gitlab_add_issue_comment",
				"gitlab_finalize_source_issue",
			],
			feedback: [
				"gitlab_observe_merge_request",
				"gitlab_get_changes",
				"gitlab_list_merge_request_feedback",
			],
			ci: ["gitlab_observe_merge_request", "gitlab_list_failed_jobs", "gitlab_get_job_trace"],
		},
		identity: (ctx) =>
			resolvePullRequestGitIdentity(ctx, "gitlab", ctx.params.gitlabProfile, false),
		async ensureRequest(ctx) {
			return gitlabPublicationRequest(
				await callFor(ctx)<GitLabMergeRequest>("gitlab_ensure_merge_request", describeRequest(ctx)),
			);
		},
		async observeTerminal(ctx, current) {
			const project = ctx.projects.find((project) => project.key === ctx.repo.get("repo").key);
			if (!current.prNumber && !(project?.metadata?.gitlab as { iid?: number } | undefined)?.iid)
				return null;
			const { mr } = await callFor(ctx)<GitLabDeliveryObservation>("gitlab_observe_merge_request");
			return mr.state === "opened" ? null : gitlabPublicationRequest(mr);
		},
		reconcileTerminal: (ctx, _current, pr) => finalizeIssue(ctx, pr),
		unchanged: (ctx) => finalizeIssue(ctx, null),
		async linkIssue(ctx, current) {
			if (ctx.params.origin === "issue")
				await callFor(ctx)("gitlab_add_issue_comment", {
					issueNumber: ctx.params.issueNumber,
					body: `Leitwerk opened merge request ${current.prUrl}.`,
					writeKey: `gitlab:${ctx.process.id}:source-mr-link:${current.prNumber}`,
				});
		},
		async acknowledge(ctx, current) {
			for (const feedback of current.feedbackIds)
				await callFor(ctx)("gitlab_acknowledge_feedback", { noteId: feedback.id });
		},
		async reply(ctx, current) {
			for (const feedback of current.feedbackIds) {
				if (!feedback.discussionId) throw new Error("GitLab feedback discussion is missing");
				await callFor(ctx)("gitlab_reply", {
					discussionId: feedback.discussionId,
					body: `Addressed in ${current.headSha?.slice(0, 8) ?? "the current revision"}.`,
					writeKey: `gitlab:${ctx.process.id}:feedback-reply:${feedback.id}:${current.headSha}`,
				});
			}
		},
		async head(ctx) {
			return (await callFor(ctx)<GitLabDeliveryObservation>("gitlab_observe_merge_request")).mr.sha;
		},
		async afterRebase(ctx, current) {
			await callFor(ctx)("gitlab_comment", {
				body: `Merge conflict repair completed at ${current.headSha}; base ${current.conflict?.baseSha}.`,
				writeKey: `rebase:${ctx.process.id}:${current.lastConflictKey}:${current.headSha}`,
			});
		},
		commitMessage: (kind) =>
			kind === "feedback" ? "fix: address GitLab review feedback" : "fix: repair GitLab pipeline",
		prompt(kind, current) {
			return kind === "feedback"
				? `Address the unseen GitLab feedback for MR !${current.prNumber}: ${JSON.stringify(current.feedbackIds)}. Read the full discussions with gitlab_list_merge_request_feedback, inspect the checkout, and make only justified changes. Call changes_ready when ready to publish, no_changes with an explicit diagnosis when no change is needed, or cannot_repair for operator action.`
				: `Diagnose GitLab pipeline ${current.pipeline?.number} for head ${current.headSha}. Read gitlab_list_failed_jobs with pipelineId and bounded gitlab_get_job_trace before making repository repairs. Call changes_ready to publish, no_changes with a justified diagnosis, or cannot_repair when operator action is needed.`;
		},
	};
	return adapter;
}
