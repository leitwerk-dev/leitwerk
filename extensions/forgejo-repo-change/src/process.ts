import { createRepositoryChangeProcess } from "@leitwerk-dev/coding";
import { commitAndPushWorkBranch, type GitIdentity } from "@leitwerk-dev/coding/finalization-git";
import type { RepositoryChangeState } from "@leitwerk-dev/coding/repository-change-state";
import {
	type ForgejoGitIdentity,
	type ForgejoPullRequest,
	forgejoExternal,
	forgejoIssueWatcherSource,
} from "@leitwerk-dev/forgejo";
import { type FlowAutomaticRunContext, flow } from "@leitwerk-dev/process-sdk";
import {
	type ConflictEvidence,
	conflictKey,
	validateConflict,
} from "@leitwerk-dev/repository-rebase";
import { publishRebase, startRebase, verifyRebase } from "@leitwerk-dev/repository-rebase/git";
import { rebasePrompt } from "@leitwerk-dev/repository-rebase/prompt";
import { type WoodpeckerPipeline, woodpeckerExternal } from "@leitwerk-dev/woodpecker";
import {
	type createForgejoRepoChangeLauncher,
	defaultForgejoRepoChangeLauncher,
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
} as const;

type FeedbackId = { kind: "conversation" | "review" | "inline"; id: number };
type AdjustmentInvocation = {
	origin: "feedback" | "ci" | "rebase";
	publishRequired: boolean;
};

interface DeliveryState {
	stage: "not_started" | "branch_published" | "pull_request_ready" | "awaiting";
	issueLinked: boolean;
	adjustment: AdjustmentInvocation | null;
	terminalPullRequest: ForgejoPullRequest | null;
	acknowledgedFeedbackIds: string[];
	repliedFeedbackIds: string[];
}

interface RemoteState {
	lastConflictKey?: string | null;
	conflict?: ConflictEvidence | null;
	repairReason?: "feedback" | "ci" | "rebase";
	headSha: string | null;
	prNumber: number | null;
	prUrl: string | null;
	conversationCursor: number;
	reviewCursor: number;
	inlineCursor: number;
	feedbackIds: FeedbackId[];
	pipeline: WoodpeckerPipeline | null;
	ciRecoveryCycles: number;
	delivery: DeliveryState;
}

const initialDeliveryState: DeliveryState = {
	stage: "not_started",
	issueLinked: false,
	adjustment: null,
	terminalPullRequest: null,
	acknowledgedFeedbackIds: [],
	repliedFeedbackIds: [],
};

const initialRemoteState: RemoteState = {
	headSha: null,
	prNumber: null,
	prUrl: null,
	conversationCursor: 0,
	reviewCursor: 0,
	inlineCursor: 0,
	feedbackIds: [],
	pipeline: null,
	ciRecoveryCycles: 0,
	delivery: initialDeliveryState,
};

function object(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function remote(state: RepositoryChangeState): RemoteState {
	const stored = object(object(state.extensionState).forgejoRepoChange);
	return {
		...initialRemoteState,
		...stored,
		delivery: {
			...initialDeliveryState,
			...object(stored.delivery),
		},
	} as RemoteState;
}

function patchRemote(
	state: RepositoryChangeState,
	patch: Partial<RemoteState>,
): RepositoryChangeState {
	const current = remote(state);
	return {
		...state,
		extensionState: {
			...state.extensionState,
			forgejoRepoChange: {
				...current,
				...patch,
				delivery: patch.delivery ?? current.delivery,
			},
		},
	};
}

function requirePr(state: RepositoryChangeState): RemoteState & {
	headSha: string;
	prNumber: number;
	prUrl: string;
} {
	const value = remote(state);
	if (!value.headSha || !value.prNumber || !value.prUrl) {
		throw new Error("Pull request delivery state is incomplete");
	}
	return value as RemoteState & {
		headSha: string;
		prNumber: number;
		prUrl: string;
	};
}

function feedbackKey(value: FeedbackId): string {
	return `${value.kind}:${value.id}`;
}

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

async function commitWorkBranch(
	ctx: FlowAutomaticRunContext<ForgejoRepoChangeParams, RepositoryChangeState>,
	commitMessage: string,
) {
	const repo = ctx.repo.get("repo");
	const resolved =
		pinnedGitIdentity(ctx) ??
		((await ctx.callIntegrationTool("forgejo_resolve_git_identity", {
			projectKey: "repo",
		})) as ForgejoGitIdentity);
	const gitIdentity: GitIdentity = { name: resolved.name, email: resolved.email };
	return commitAndPushWorkBranch({
		repoPath: repo.fsPath,
		workBranch: repo.workBranch,
		commitMessage,
		gitIdentity,
	});
}

async function call<T>(
	ctx: {
		callIntegrationTool(name: string, args: Record<string, unknown>): Promise<unknown>;
	},
	name: string,
	args: Record<string, unknown>,
): Promise<T> {
	return (await ctx.callIntegrationTool(name, args)) as T;
}

function deliveryResult(
	outcome: "awaiting" | "feedback_ready" | "completed" | "aborted",
	nextState: RepositoryChangeState,
) {
	return { outcome, params: { nextState } };
}

function deliveryProgress(
	state: RepositoryChangeState,
	activeStepId?: string,
	completedStepIds: readonly string[] = [],
) {
	const value = remote(state);
	const delivery = value.delivery;
	const completed = new Set(completedStepIds);
	const step = (id: string, label: string, done: boolean) => ({
		id,
		label,
		status: (activeStepId === id
			? "in_progress"
			: done || completed.has(id)
				? "completed"
				: "incomplete") as "in_progress" | "completed" | "incomplete",
	});
	const adjustmentHandled =
		delivery.adjustment === null && delivery.stage === "awaiting" && value.headSha !== null;
	return {
		title: "Delivery progress",
		steps: [
			step("publish_branch", "Publish work branch", value.headSha !== null),
			step("open_pr", "Create or find pull request", value.prNumber !== null),
			step("link_issue", "Link source issue when applicable", delivery.issueLinked),
			step("publish_adjustment", "Publish an adjustment when applicable", adjustmentHandled),
			step(
				"reply_feedback",
				"Acknowledge or reply to feedback when applicable",
				value.feedbackIds.length === 0,
			),
			step("await_evidence", "Await external evidence", delivery.stage === "awaiting"),
			step(
				"reconcile_terminal",
				"Reconcile terminal pull request",
				delivery.terminalPullRequest !== null,
			),
		],
		...(value.prNumber && value.prUrl
			? {
					links: [
						{
							id: `forgejo-pr-${value.prNumber}`,
							label: `Forgejo PR #${value.prNumber}`,
							url: value.prUrl,
							kind: "pull_request" as const,
						},
					],
				}
			: {}),
	};
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

export function createForgejoRepoChangeProcess(
	launcher: ReturnType<typeof createForgejoRepoChangeLauncher>,
	docker: boolean,
) {
	const publication = flow.fragment<ForgejoRepoChangeParams, RepositoryChangeState>(
		"forgejo-publication",
	);

	publication.turn(
		flow
			.automatic<ForgejoRepoChangeParams, RepositoryChangeState>(ids.deliver)
			.description("Deliver")
			.integrationTools(...deliveryTools)
			.run(async (ctx) => {
				let next = structuredClone(ctx.state) as RepositoryChangeState;
				let current = remote(next);
				ctx.reportProgress(deliveryProgress(next));

				if (current.delivery.terminalPullRequest) {
					ctx.reportProgress(deliveryProgress(next, "reconcile_terminal"));
					const pr = current.delivery.terminalPullRequest;
					if (!isIssueOrigin(ctx.params)) {
						ctx.reportProgress(deliveryProgress(next, undefined, ["reconcile_terminal"]));
						return deliveryResult(pr.merged ? "completed" : "aborted", next);
					}
					const issue = await call<{
						labels: Array<{ id: number; name: string }>;
					}>(ctx, "forgejo_get_issue", {
						projectKey: "repo",
						issueNumber: ctx.params.issueNumber,
					});
					const labelIds = issue.labels
						.filter((label) => label.name !== ctx.params.triggerLabel)
						.map((label) => label.id);
					if (pr.merged) {
						const done = await call<{ id: number }>(ctx, "forgejo_ensure_label", {
							projectKey: "repo",
							name: ctx.params.doneLabel,
						});
						await call(ctx, "forgejo_update_issue", {
							projectKey: "repo",
							issueNumber: ctx.params.issueNumber,
							patch: {
								labels: [...new Set([...labelIds, done.id])],
								state: "closed",
							},
							writeKey: `forgejo:${ctx.process.id}:complete-source-issue`,
						});
						await call(ctx, "forgejo_add_issue_comment", {
							projectKey: "repo",
							issueNumber: ctx.params.issueNumber,
							body: `Merged ${pr.html_url}${pr.merge_commit_sha ? ` at ${pr.merge_commit_sha}` : ""}.`,
							writeKey: `forgejo:${ctx.process.id}:merged-pr-comment`,
						});
						ctx.reportProgress(deliveryProgress(next, undefined, ["reconcile_terminal"]));
						return deliveryResult("completed", next);
					}
					await call(ctx, "forgejo_update_issue", {
						projectKey: "repo",
						issueNumber: ctx.params.issueNumber,
						patch: { labels: labelIds },
						writeKey: `forgejo:${ctx.process.id}:remove-source-trigger`,
					});
					await call(ctx, "forgejo_add_issue_comment", {
						projectKey: "repo",
						issueNumber: ctx.params.issueNumber,
						body: `Leitwerk stopped because ${pr.html_url} was closed without merge.`,
						writeKey: `forgejo:${ctx.process.id}:closed-pr-comment`,
					});
					ctx.reportProgress(deliveryProgress(next, undefined, ["reconcile_terminal"]));
					return deliveryResult("aborted", next);
				}

				if (!current.headSha) {
					ctx.reportProgress(deliveryProgress(next, "publish_branch"));
					const published = await commitWorkBranch(
						ctx,
						ctx.state.finalization.generatedCommitMessage ?? "",
					);
					next = patchRemote(next, {
						headSha: published.headSha,
						pipeline: null,
						delivery: { ...current.delivery, stage: "branch_published" },
					});
					current = remote(next);
				}

				if (!current.prNumber || !current.prUrl) {
					ctx.reportProgress(deliveryProgress(next, "open_pr"));
					const project = ctx.repo.get("repo");
					const issueOrigin = isIssueOrigin(ctx.params);
					const pr = await call<ForgejoPullRequest>(ctx, "forgejo_ensure_pull_request", {
						projectKey: "repo",
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
					next = patchRemote(next, {
						prNumber: pr.number,
						prUrl: pr.html_url,
						delivery: { ...current.delivery, stage: "pull_request_ready" },
					});
					current = remote(next);
				}

				if (!current.delivery.issueLinked) {
					ctx.reportProgress(deliveryProgress(next, "link_issue"));
					if (isIssueOrigin(ctx.params)) {
						await call(ctx, "forgejo_add_issue_comment", {
							projectKey: "repo",
							issueNumber: ctx.params.issueNumber,
							body: `Leitwerk opened pull request ${current.prUrl}.`,
							writeKey: `forgejo:${ctx.process.id}:source-pr-link:${current.prNumber}`,
						});
					}
					next = patchRemote(next, {
						delivery: { ...current.delivery, issueLinked: true },
					});
					current = remote(next);
				}

				if (current.delivery.adjustment) {
					const adjustment = current.delivery.adjustment;
					if (adjustment.publishRequired || adjustment.origin === "rebase") {
						if (adjustment.origin === "rebase") verifyRebase(rebaseInput(ctx));
						ctx.reportProgress(deliveryProgress(next, "publish_adjustment"));
						const published =
							adjustment.origin === "rebase"
								? publishRebase(rebaseInput(ctx))
								: await commitWorkBranch(
										ctx,
										adjustment.origin === "feedback"
											? "fix: address Forgejo review feedback"
											: "fix: repair Woodpecker pipeline",
									);
						if (adjustment.origin === "rebase") {
							const refreshed = await call<ForgejoPullRequest>(ctx, "forgejo_get_pull_request", {
								projectKey: "repo",
								pullRequestNumber: current.prNumber,
							});
							if (refreshed.head.sha !== published.headSha)
								throw new Error("Pull request head has not caught up with rebase publication");
						}
						next = patchRemote(next, {
							headSha: published.headSha,
							pipeline: null,
						});
						current = remote(next);
					}
					if (adjustment.origin === "rebase")
						await call(ctx, "forgejo_add_pull_request_comment", {
							projectKey: "repo",
							pullRequestNumber: current.prNumber,
							body: `Merge conflict repair completed at ${current.headSha}; base ${current.conflict?.baseSha}.`,
							writeKey: `rebase:${ctx.process.id}:${current.lastConflictKey}:${current.headSha}`,
						});
					if (adjustment.origin === "feedback") {
						ctx.reportProgress(deliveryProgress(next, "reply_feedback"));
						for (const feedback of current.feedbackIds) {
							await call(ctx, "forgejo_reply_to_pull_request_feedback", {
								projectKey: "repo",
								pullRequestNumber: current.prNumber,
								feedbackKind: feedback.kind,
								feedbackId: feedback.id,
								body: `Addressed in ${current.headSha?.slice(0, 8) ?? "the current revision"}.`,
								writeKey: `forgejo:${ctx.process.id}:feedback-reply:${feedbackKey(feedback)}:${current.headSha}`,
							});
						}
						next = patchRemote(next, {
							feedbackIds: [],
							delivery: {
								...current.delivery,
								adjustment: null,
								repliedFeedbackIds: [
									...new Set([
										...current.delivery.repliedFeedbackIds,
										...current.feedbackIds.map(feedbackKey),
									]),
								],
							},
						});
					} else {
						next = patchRemote(next, {
							delivery: { ...current.delivery, adjustment: null },
						});
					}
					current = remote(next);
				}

				if (current.feedbackIds.length > 0) {
					ctx.reportProgress(deliveryProgress(next, "reply_feedback"));
					for (const feedback of current.feedbackIds) {
						if (feedback.kind === "review") continue;
						await call(ctx, "forgejo_add_pull_request_feedback_reaction", {
							projectKey: "repo",
							pullRequestNumber: current.prNumber,
							feedbackKind: feedback.kind,
							feedbackId: feedback.id,
							writeKey: `forgejo:${ctx.process.id}:feedback-eyes:${feedbackKey(feedback)}`,
						});
					}
					next = patchRemote(next, {
						delivery: {
							...current.delivery,
							acknowledgedFeedbackIds: [
								...new Set([
									...current.delivery.acknowledgedFeedbackIds,
									...current.feedbackIds.map(feedbackKey),
								]),
							],
						},
					});
					return deliveryResult("feedback_ready", next);
				}

				next = patchRemote(next, {
					delivery: { ...current.delivery, stage: "awaiting" },
				});
				ctx.reportProgress(deliveryProgress(next, "await_evidence"));
				return deliveryResult("awaiting", next);
			})
			.outcome("awaiting", (outcome) =>
				outcome
					.description("Delivery is waiting for external evidence")
					.object("nextState")
					.wait()
					.state(({ event }) => event.params.nextState as RepositoryChangeState),
			)
			.outcome("feedback_ready", (outcome) =>
				outcome
					.description("Pull request feedback is acknowledged and ready for revision")
					.object("nextState")
					.to(ids.feedback)
					.state(({ event }) => event.params.nextState as RepositoryChangeState),
			)
			.outcome("completed", (outcome) =>
				outcome
					.description("Merged pull request was reconciled")
					.object("nextState")
					.complete()
					.state(({ event }) => event.params.nextState as RepositoryChangeState),
			)
			.outcome("aborted", (outcome) =>
				outcome
					.description("Closed pull request was reconciled")
					.object("nextState")
					.lifecycleStatus("aborted")
					.state(({ event }) => event.params.nextState as RepositoryChangeState),
			)

			.externalAction(
				"forgejo_merge_conflict",
				forgejoExternal.pullRequestConflict(({ params, state }) => ({
					profile: params.forgejoProfile,
					owner: params.owner,
					repo: params.repo,
					prNumber: requirePr(state).prNumber,
					headSha: requirePr(state).headSha,
					lastConflictKey: remote(state).lastConflictKey,
					pollInterval: "30s",
				})),
				(external) =>
					external
						.label("Rebase conflicting pull request")
						.to(ids.feedback)
						.effect(({ params, state, event }) => {
							const current = requirePr(state);
							const conflict = validateConflict(
								object(event).conflict,
								{
									owner: params.owner,
									repo: params.repo,
									prNumber: current.prNumber,
									headSha: current.headSha,
									headBranch: params.workBranch,
									baseBranch: params.baseBranch,
								},
								current.lastConflictKey,
							);
							return {
								state: patchRemote(state, {
									lastConflictKey: conflictKey(conflict),
									conflict,
									repairReason: "rebase",
								}),
							};
						}),
			)
			.externalAction(
				"forgejo_feedback",
				forgejoExternal.pullRequestFeedback(({ params, state }) => {
					const current = requirePr(state);
					return {
						profile: params.forgejoProfile,
						owner: params.owner,
						repo: params.repo,
						prNumber: current.prNumber,
						conversationCursor: current.conversationCursor,
						reviewCursor: current.reviewCursor,
						inlineCursor: current.inlineCursor,
						quietPeriodMs: 120_000,
						pollInterval: "30s",
					};
				}),
				(external) =>
					external
						.label("Forgejo pull request feedback")
						.to(ids.deliver)
						.effect(({ state, event }) => {
							const value = object(event);
							const cursors = object(value.cursors);
							return {
								state: patchRemote(state, {
									repairReason: "feedback",
									conversationCursor: Number(
										cursors.conversationCursor ?? remote(state).conversationCursor,
									),
									reviewCursor: Number(cursors.reviewCursor ?? remote(state).reviewCursor),
									inlineCursor: Number(cursors.inlineCursor ?? remote(state).inlineCursor),
									feedbackIds: Array.isArray(value.feedbackIds)
										? (value.feedbackIds as FeedbackId[])
										: [],
								}),
							};
						}),
			)
			.externalAction(
				"woodpecker_failure_repair",
				woodpeckerExternal.pipeline(({ params, state }) => {
					const current = requirePr(state);
					return {
						profile: params.woodpeckerProfile,
						owner: params.owner,
						repo: params.repo,
						branch: params.workBranch,
						headSha: current.headSha,
						afterPipelineNumber: current.pipeline?.number ?? 0,
						statuses: [
							"failure",
							"error",
							"killed",
							"canceled",
							"cancelled",
							"declined",
							"blocked",
						],
						pollInterval: "30s",
					};
				}),
				(external) =>
					external
						.label("Repair failed Woodpecker pipeline")
						.when(({ state }) => remote(state).ciRecoveryCycles < 3)
						.to(ids.ciRepair)
						.effect(({ state, event }) => ({
							state: patchRemote(state, {
								repairReason: "ci",
								pipeline: object(event).pipeline as WoodpeckerPipeline,
								ciRecoveryCycles: remote(state).ciRecoveryCycles + 1,
							}),
						})),
			)
			.externalAction(
				"woodpecker_failure_operator",
				woodpeckerExternal.pipeline(({ params, state }) => {
					const current = requirePr(state);
					return {
						profile: params.woodpeckerProfile,
						owner: params.owner,
						repo: params.repo,
						branch: params.workBranch,
						headSha: current.headSha,
						afterPipelineNumber: current.pipeline?.number ?? 0,
						statuses: [
							"failure",
							"error",
							"killed",
							"canceled",
							"cancelled",
							"declined",
							"blocked",
						],
						pollInterval: "30s",
					};
				}),
				(external) =>
					external
						.label("Escalate failed Woodpecker pipeline")
						.when(({ state }) => remote(state).ciRecoveryCycles >= 3)
						.to(ids.operator)
						.effect(({ state, event }) => ({
							state: patchRemote(state, {
								repairReason: "ci",
								pipeline: object(event).pipeline as WoodpeckerPipeline,
							}),
						})),
			)
			.externalAction(
				"forgejo_pr_merged",
				forgejoExternal.pullRequestTerminal(({ params, state }) => ({
					profile: params.forgejoProfile,
					owner: params.owner,
					repo: params.repo,
					prNumber: requirePr(state).prNumber,
					terminalOutcome: "merged",
					pollInterval: "30s",
				})),
				(external) =>
					external
						.label("Forgejo pull request merged")
						.to(ids.deliver)
						.effect(({ state, event }) => {
							const current = remote(state);
							return {
								state: patchRemote(state, {
									delivery: {
										...current.delivery,
										terminalPullRequest: object(event).pullRequest as ForgejoPullRequest,
									},
								}),
							};
						}),
			)
			.externalAction(
				"forgejo_pr_closed",
				forgejoExternal.pullRequestTerminal(({ params, state }) => ({
					profile: params.forgejoProfile,
					owner: params.owner,
					repo: params.repo,
					prNumber: requirePr(state).prNumber,
					terminalOutcome: "closed",
					pollInterval: "30s",
				})),
				(external) =>
					external
						.label("Forgejo pull request closed without merge")
						.to(ids.deliver)
						.effect(({ state, event }) => {
							const current = remote(state);
							return {
								state: patchRemote(state, {
									delivery: {
										...current.delivery,
										terminalPullRequest: object(event).pullRequest as ForgejoPullRequest,
									},
								}),
							};
						}),
			)
			.externalAction(
				"source_cancelled",
				forgejoExternal.issueCancelled(({ params }) => {
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
				(external) =>
					external
						.label("Source issue cancelled")
						.when(({ params }) => isIssueOrigin(params))
						.lifecycleStatus("aborted"),
			),
	);

	function rebaseInput(ctx: {
		state: RepositoryChangeState;
		repo: { get(key: string): { fsPath: string; workBranch: string } };
	}) {
		const project = ctx.repo.get("repo");
		const conflict = remote(ctx.state).conflict;
		if (!conflict) throw new Error("Missing conflict evidence");
		return { projectKey: "repo", path: project.fsPath, workBranch: project.workBranch, conflict };
	}
	function repairReason(state: RepositoryChangeState, kind: "feedback" | "ci") {
		return kind === "feedback" && remote(state).repairReason === "rebase" ? "rebase" : kind;
	}

	function revisionPrompt(kind: "feedback" | "ci") {
		return (ctx: { state: RepositoryChangeState }) => {
			const current = remote(ctx.state);
			if (repairReason(ctx.state, kind) === "rebase")
				return `${rebasePrompt} Evidence: ${JSON.stringify(current.conflict)}. Call changes_ready or no_changes when verified complete, cannot_repair when blocked.`;
			return kind === "feedback"
				? `Address the unseen Forgejo pull-request feedback batch for PR #${current.prNumber}. Feedback identifiers: ${JSON.stringify(current.feedbackIds)}. Inspect the current checkout and use Forgejo tools to read the full feedback. Do not rely on an earlier plan or conversation. Make only justified repository changes. Call changes_ready if files need publishing, no_changes after an explicit diagnosis that no repository change is needed, or cannot_repair when operator action is required.`
				: `Diagnose Woodpecker pipeline #${current.pipeline?.number ?? "unknown"} (${current.pipeline?.status ?? "unknown"}) for the current checkout. Use Woodpecker tools to inspect pipeline metadata and bounded failed-step logs before changing anything. Fix repository causes. Call changes_ready for repository changes, no_changes only after an explicit provider restart or a justified diagnosis that no repository change is needed, or cannot_repair when operator action is required.`;
		};
	}

	function revisionTurn(id: string, kind: "feedback" | "ci") {
		return flow
			.llm<ForgejoRepoChangeParams, RepositoryChangeState>(id)
			.description(kind === "feedback" ? "Address Feedback" : "Fix CI")
			.tools("read", "bash", "edit", "write")
			.resolveIntegrationTools((_params, state) =>
				repairReason(state, kind) === "rebase"
					? []
					: kind === "feedback"
						? ["forgejo_get_pull_request", "forgejo_list_pull_request_feedback"]
						: [
								"woodpecker_lookup_repository",
								"woodpecker_list_pipelines",
								"woodpecker_get_pipeline",
								"woodpecker_get_step_logs",
								"woodpecker_restart_pipeline",
							],
			)
			.prepare((ctx) =>
				repairReason(ctx.state, kind) === "rebase" ? startRebase(rebaseInput(ctx)) : {},
			)
			.freshPrimary()
			.prompt(revisionPrompt(kind))
			.outcomeTool("changes_ready", (tool) =>
				tool
					.resultSummary()
					.description("Repository changes are ready to publish")
					.to(ids.deliver)
					.state(({ ctx }) => {
						const current = remote(ctx.state);
						return patchRemote(ctx.state, {
							delivery: {
								...current.delivery,
								adjustment: { origin: repairReason(ctx.state, kind), publishRequired: true },
							},
						});
					}),
			)
			.outcomeTool("no_changes", (tool) =>
				tool
					.resultSummary()
					.description("No repository change is required")
					.to(ids.deliver)
					.state(({ ctx }) => {
						const current = remote(ctx.state);
						return patchRemote(ctx.state, {
							delivery: {
								...current.delivery,
								adjustment: { origin: repairReason(ctx.state, kind), publishRequired: false },
							},
						});
					}),
			)
			.outcomeTool("cannot_repair", (tool) =>
				tool.description("The adjustment requires operator action").to(ids.operator),
			);
	}

	publication.turn(revisionTurn(ids.feedback, "feedback"));
	publication.turn(revisionTurn(ids.ciRepair, "ci"));
	publication.turn({
		id: ids.operator,
		definition: {
			kind: "human",
			description: "Repository repair needs operator action",
			operatorAttention: "required",
			actions: {
				retry_repair: {
					label: "Retry repair",
					acceptanceState: "accepted",
					branches: { feedback: { to: ids.feedback }, ci: { to: ids.ciRepair } },
					choose: ({ ctx }) =>
						remote(ctx.state).repairReason === "rebase" ||
						remote(ctx.state).repairReason === "feedback"
							? "feedback"
							: "ci",
				},
				resume_waiting: {
					label: "Resume waiting",
					acceptanceState: "accepted",
					to: ids.deliver,
					effect: ({ ctx }) => ({
						state: patchRemote(ctx.state, {
							feedbackIds: [],
							delivery: { ...remote(ctx.state).delivery, adjustment: null },
						}),
					}),
				},
				abort: { label: "Abort process", acceptanceState: "neutral", lifecycleStatus: "aborted" },
			},
		},
	});

	publication.watcher({
		id: "use_leitwerk",
		label: "Forgejo use-leitwerk issues",
		description: "Launch a remote repository change for Forgejo issues carrying the trigger label",
		source: forgejoIssueWatcherSource,
		preparationChecks: launcher.preparationChecks,
		async resolveLaunchConfig({ profile, repository, issue, labels }) {
			const owner = repository.owner.login;
			const repo = repository.name;
			const issueNumber = issue.number;
			const title = issue.title.trim();
			const body = issue.body?.trim() ?? "";
			const issueUrl = issue.html_url;
			const binding = launcher.resolveProfiles(profile);
			const gitIdentity = await launcher.resolveGitIdentity(profile);
			const params: ForgejoRepoChangeParams = {
				launchKind: "requested_change",
				origin: "issue",
				repoLocator: repository.ssh_url,
				baseBranch: repository.default_branch,
				workBranch: `leitwerk/issue-${issueNumber}`,
				prompt: `${title}${body ? `\n\n${body}` : ""}`,
				forgejoProfile: profile,
				woodpeckerProfile: binding.woodpeckerProfile,
				sshCredentialRef: binding.sshCredentialRef,
				owner,
				repo,
				issueNumber,
				issueUrl,
				triggerLabel: labels.trigger,
				doneLabel: labels.done,
			};
			return {
				processId,
				params,
				title,
				externalId: `forgejo:${owner}/${repo}#${issueNumber}`,
				externalUrl: issueUrl,
				startTurnId: "generate_plan",
				projects: [
					{
						key: "repo",
						repoLocator: params.repoLocator,
						baseBranch: params.baseBranch,
						workBranch: params.workBranch,
						externalId: String(issueNumber),
						externalUrl: issueUrl,
						metadata: {
							forgejo: { owner, repo, profile, issueNumber },
							woodpecker: { owner, repo, profile: binding.woodpeckerProfile },
							"leitwerk.gitIdentity": gitIdentity,
						},
					},
				],
			};
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
		finalizationDescription: "Publish feature branch",
		repositoryCredentials: ({ params }) => [
			{
				projectKey: "repo",
				kind: "git_ssh",
				credentialRef: params.sshCredentialRef,
			},
		],
		publication: {
			entryTurnId: ids.deliver,
			fragment: publication,
			happyPath: [ids.deliver],
		},
	});

	definition.process.runtime = { ...definition.process.runtime, docker };

	return definition.process;
}

export const forgejoRepoChangeProcess = createForgejoRepoChangeProcess(
	defaultForgejoRepoChangeLauncher,
	true,
);
