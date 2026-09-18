import {
	type CoreServerSetupDeps,
	createExternalSourcePollReporter,
	type ExternalActionSource,
} from "@leitwerk-dev/process-sdk";
import { emptyPollResult, parseDurationMs } from "@leitwerk-dev/watcher-utils";
import type { GitLabIntegration } from "./capability.js";
import { type GitLabFeedback, type GitLabObservation, observeMergeRequest } from "./client.js";
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
	/** Optional timer also wakes retry work when GitLab facts have not changed. @public */
	wakeAt?: number;
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
/** A trailing quiet period survives restarts because it uses the newest unseen note's timestamp. @public */
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
export const observationKey = ({ mr, pipeline }: GitLabObservation): string =>
	JSON.stringify([
		mr.state,
		mr.sha,
		[...mr.labels].sort(),
		pipeline?.project_id,
		pipeline?.id,
		pipeline?.status,
	]);
/** @public */
export const gitlabExternal = {
	/** @public */
	mergeRequest<P, S>(
		resolve: (ctx: {
			/** @public */
			params: P;
			/** @public */
			state: S;
		}) => GitLabSourceConfig,
	): ExternalActionSource<P, S, GitLabObservation> {
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
	options: {
		/** @internal */
		now?: () => number;
	} = {},
) {
	const schedule = new Map<string, { at: number; failures: number }>();
	const now = options.now ?? Date.now;
	return deps.polling.create({
		id: "gitlab",
		pollInterval: () => "5s",
		isEnabled: () => true,
		defaultIntervalMs: 5000,
		async pollOnce() {
			const result = emptyPollResult();
			const report = createExternalSourcePollReporter(deps.externalSources, result);
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
					const observedKey = observationKey(observation);
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
							{ ...observation },
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
			return result;
		},
	});
}
