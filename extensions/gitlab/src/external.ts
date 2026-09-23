import {
	type CoreServerSetupDeps,
	createExternalSourcePollReporter,
	type ExternalActionSource,
	type ExternalSourceArmingLike,
} from "@leitwerk-dev/process-sdk";
import { type ConflictEvidence, conflictKey } from "@leitwerk-dev/repository-rebase";
import { emptyPollResult, parseDurationMs } from "@leitwerk-dev/watcher-utils";
import type { GitLabIntegration } from "./capability.js";
import { type GitLabFeedback, type GitLabObservation, observeMergeRequest } from "./client.js";
import { createGitLabIssueDiscovery } from "./issue-watcher.js";
/** @public */
export interface GitLabDeliveryObservation extends GitLabObservation {
	/** @public */
	observationKey?: string;
	/** @public */
	feedback?: GitLabFeedback[];
	/** @public */
	conflict?: ConflictEvidence;
}
/** @public */
export const GITLAB_ISSUE_CANCELLED_KIND = "@leitwerk-dev/gitlab.issue-cancelled";
/** @public */
export interface GitLabIssueCancelledConfig {
	/** @public */
	profile: string;
	/** @public */
	projectId: number;
	/** @public */
	issueIid: number;
	/** @public */
	iid: number;
	/** @public */
	triggerLabel: string;
	/** @public */
	pollInterval?: string;
}
/** @internal */
export const GITLAB_MR_KIND = "@leitwerk-dev/gitlab.merge-request";
/** @public */
export interface GitLabSourceConfig {
	/** @public */
	profile: string;
	/** @public */
	projectId: number;
	/** @public */
	iid: number;
	/** @public */
	pollInterval?: string;
	/** @public */
	afterKey?: string;
	/** Optional timer also wakes retry work when GitLab facts have not changed. */
	/** @public */
	wakeAt?: number;
	/** @public */
	delivery?: {
		/** @public */
		headSha: string;
		/** @public */
		owner: string;
		/** @public */
		repo: string;
		/** @public */
		headBranch: string;
		/** @public */
		baseBranch: string;
		/** @public */
		lastConflictKey?: string | null;
	};
	/** @public */
	feedback?: {
		/** @public */
		afterId: number;
		/** @public */
		since?: string;
		/** @public */
		quietPeriodMs: number;
	};
}
/** A trailing quiet period survives restarts because it uses the newest unseen note's timestamp. */
/** @public */
export function pendingGitLabFeedback(
	items: GitLabFeedback[],
	afterId: number,
	since?: string,
): GitLabFeedback[] {
	const start = since ? Date.parse(since) : 0;
	return items.filter((item) => item.id > afterId && Date.parse(item.createdAt) >= start);
}
/** @public */
export function gitLabFeedbackReadyAt(
	items: GitLabFeedback[],
	quietPeriodMs: number,
): number | null {
	return items.length
		? Math.max(...items.map((item) => Date.parse(item.createdAt))) + quietPeriodMs
		: null;
}
/** @public */
export const observationKey = ({ mr, pipeline, targetHead }: GitLabObservation): string =>
	JSON.stringify([
		mr.state,
		mr.sha,
		[...mr.labels].sort(),
		pipeline?.project_id,
		pipeline?.id,
		pipeline?.status,
		mr.source_project_id,
		mr.source_branch,
		mr.target_project_id,
		mr.target_branch,
		targetHead,
		mr.has_conflicts,
		mr.merge_status,
		mr.detailed_merge_status,
	]);
/** @public */
export const gitlabExternal = {
	/** @public */
	issueCancelled<P, S>(
		/** @public */
		resolve: (ctx: {
			/** @public */
			params: P;
			/** @public */
			state: S;
		}) => GitLabIssueCancelledConfig,
	): ExternalActionSource<P, S, unknown> {
		return {
			kind: GITLAB_ISSUE_CANCELLED_KIND,
			label: "GitLab source issue cancelled",
			config: {},
			inputMode: "none",
			resolve,
		};
	},
	/** @public */
	mergeRequest<P, S>(
		/** @public */
		resolve: (ctx: {
			/** @public */
			params: P;
			/** @public */
			state: S;
		}) => GitLabSourceConfig,
	): ExternalActionSource<P, S, GitLabDeliveryObservation> {
		return {
			kind: GITLAB_MR_KIND,
			label: "GitLab merge request",
			description: "Observe MR state, current source head and revision-correlated CI",
			config: {},
			inputMode: "none",
			resolve,
		};
	},
};
/** @internal */
export function createGitLabProvider(
	deps: CoreServerSetupDeps,
	integration: GitLabIntegration,
	/** @public */
	options: {
		/** @internal */ now?: () => number;
	} = {},
) {
	const schedule = new Map<string, { at: number; failures: number }>();
	const now = options.now ?? Date.now;
	const discover = createGitLabIssueDiscovery(deps, integration, now);
	return deps.polling.create({
		id: "gitlab",
		pollInterval: () => "5s",
		isEnabled: () => true,
		defaultIntervalMs: 5000,
		async pollOnce() {
			const result = emptyPollResult();
			try {
				await discover(result);
			} catch (error) {
				result.errors.push(error instanceof Error ? error.message : "GitLab discovery failed");
			}
			const reporter = createExternalSourcePollReporter(deps.externalSources, result, {
				forwardGeneration: true,
			});
			const current = (armed: ExternalSourceArmingLike) =>
				[GITLAB_MR_KIND, GITLAB_ISSUE_CANCELLED_KIND].some((kind) =>
					reporter.isCurrent(kind, armed),
				);
			const report = {
				...reporter,
				fire(armed: ExternalSourceArmingLike, event: Record<string, unknown>, mergeKey: string) {
					return current(armed) ? reporter.fire(armed, event, mergeKey) : Promise.resolve(false);
				},
				observe(armed: ExternalSourceArmingLike, input: Parameters<typeof reporter.observe>[1]) {
					if (current(armed)) return reporter.observe(armed, input);
				},
			};
			await report.poll(GITLAB_MR_KIND, async (armed) => {
				const c = armed.resolved as unknown as GitLabSourceConfig;
				if (
					!c ||
					typeof c.profile !== "string" ||
					!Number.isInteger(c.projectId) ||
					!Number.isInteger(c.iid)
				)
					throw new Error("Invalid GitLab external source");
				const key = `${armed.instanceId}:${armed.id}:${armed.generation ?? ""}`;
				const previous = schedule.get(key);
				if (previous && previous.at > now()) return;
				try {
					const observation = await observeMergeRequest(
						integration.client(c.profile),
						c.projectId,
						c.iid,
					);
					let conflict: ConflictEvidence | undefined;
					const client = integration.client(c.profile);
					if (
						c.delivery &&
						observation.mr.state === "opened" &&
						observation.mr.sha === c.delivery.headSha &&
						(observation.mr.has_conflicts === true ||
							observation.mr.detailed_merge_status === "conflict")
					) {
						const mr = observation.mr;
						const d = c.delivery;
						if (
							mr.source_project_id !== c.projectId ||
							mr.target_project_id !== c.projectId ||
							mr.source_branch !== d.headBranch ||
							mr.target_branch !== d.baseBranch
						)
							throw new Error("GitLab merge request branches changed");
						const base = await client.getBranch(c.projectId, d.baseBranch);
						const evidence: ConflictEvidence = {
							owner: d.owner,
							repo: d.repo,
							prNumber: c.iid,
							headBranch: d.headBranch,
							baseBranch: d.baseBranch,
							headSha: mr.sha,
							baseSha: base.commit.id,
							url: mr.web_url,
						};
						if (conflictKey(evidence) !== d.lastConflictKey) conflict = evidence;
					}
					const observedKey =
						observationKey(observation) +
						(c.delivery ? `:${conflict ? conflictKey(conflict) : ""}` : "");
					const feedback =
						c.feedback && observation.mr.state === "opened"
							? pendingGitLabFeedback(
									await integration.client(c.profile).listMergeRequestFeedback(c.projectId, c.iid),
									c.feedback.afterId,
									c.feedback.since,
								)
							: [];
					const feedbackReadyAt = gitLabFeedbackReadyAt(
						feedback,
						c.feedback?.quietPeriodMs ?? 120_000,
					);
					const feedbackReady = feedbackReadyAt !== null && feedbackReadyAt <= now();
					if (c.delivery) {
						const fresh = await client.getMergeRequest(c.projectId, c.iid);
						if (fresh.sha !== observation.mr.sha || fresh.state !== observation.mr.state) return;
					}
					await report.observe(armed, {
						observation: {
							summary: `${observation.mr.state} · ${observation.pipeline?.status ?? "no current pipeline"}`,
							observedAt: new Date(now()).toISOString(),
							subject: observation.mr.web_url,
							revision: observation.mr.sha,
						},
					});
					if (
						observedKey !== c.afterKey ||
						feedbackReady ||
						(c.wakeAt !== undefined && c.wakeAt <= now())
					)
						await report.fire(
							armed,
							{
								...observation,
								...(c.delivery
									? {
											observationKey: observedKey,
											feedback: feedbackReady ? feedback : [],
											...(conflict ? { conflict } : {}),
										}
									: {}),
							},
							`${observedKey}:${c.wakeAt ?? ""}:${feedbackReady ? feedback.map((item) => item.id).join(",") : ""}`,
						);
					schedule.set(key, {
						at: now() + parseDurationMs(c.pollInterval ?? "30s", 30000),
						failures: 0,
					});
				} catch (error) {
					const failures = (previous?.failures ?? 0) + 1;
					schedule.set(key, {
						at: now() + Math.min(300000, 30000 * 2 ** Math.min(failures - 1, 4)),
						failures,
					});
					await report.observe(armed, {
						refreshError: error instanceof Error ? error.message : "GitLab observation unavailable",
					});
					throw error;
				}
			});
			await report.poll(GITLAB_ISSUE_CANCELLED_KIND, async (armed) => {
				const c = armed.resolved as unknown as GitLabIssueCancelledConfig;
				const key = `${armed.instanceId}:${armed.id}:${armed.generation ?? ""}`;
				if ((schedule.get(key)?.at ?? 0) > now()) return;
				const client = integration.client(c.profile);
				const issue = await client.getIssue(c.projectId, c.issueIid);
				if (issue.state !== "opened" || !issue.labels.includes(c.triggerLabel)) {
					const mr = await client.getMergeRequest(c.projectId, c.iid);
					if (mr.state !== "opened") return;
					await report.fire(
						armed,
						{ issue },
						`${issue.iid}:${issue.state}:${issue.labels.includes(c.triggerLabel)}`,
					);
				}
				schedule.set(key, {
					at: now() + parseDurationMs(c.pollInterval ?? "30s", 30000),
					failures: 0,
				});
			});
			return result;
		},
	});
}
