import { asUnknownRecord } from "@leitwerk-dev/domain";
import {
	type CoreServerSetupDeps,
	createExternalSourcePollReporter,
} from "@leitwerk-dev/process-sdk";
import {
	conflictEvidence,
	conflictKey,
	describeConflict,
	sameSubscription,
} from "@leitwerk-dev/repository-rebase";
import { createPollSchedule, emptyPollResult } from "@leitwerk-dev/watcher-utils";
import type { GitHubIntegration } from "./capability.js";
import {
	describeGitHubEvent,
	GITHUB_PR_STATE_KIND,
	GITHUB_RELEASE_KIND,
	type GitHubPullRequestSourceConfig,
} from "./external.js";

function parse(value: unknown): GitHubPullRequestSourceConfig | null {
	const config = asUnknownRecord(value) ?? {};
	if (
		["profile", "owner", "repo", "headSha"].some(
			(key) => typeof config[key] !== "string" || !(config[key] as string).trim(),
		) ||
		typeof config.prNumber !== "number"
	)
		return null;
	return {
		profile: config.profile as string,
		owner: config.owner as string,
		repo: config.repo as string,
		prNumber: config.prNumber,
		headSha: config.headSha as string,
		lastConflictKey: typeof config.lastConflictKey === "string" ? config.lastConflictKey : null,
		feedbackCursor: typeof config.feedbackCursor === "number" ? config.feedbackCursor : 0,
		pollInterval: typeof config.pollInterval === "string" ? config.pollInterval : "30s",
		disabled: config.disabled === true,
		eventKinds: Array.isArray(config.eventKinds)
			? config.eventKinds.filter(
					(value): value is "checks" | "feedback" | "merged" | "closed" | "merge_conflict" =>
						["checks", "feedback", "merged", "closed", "merge_conflict"].includes(String(value)),
				)
			: undefined,
		checkStatuses: Array.isArray(config.checkStatuses)
			? config.checkStatuses.filter((value): value is "pending" | "success" | "failure" =>
					["pending", "success", "failure"].includes(String(value)),
				)
			: undefined,
	};
}

export function createGitHubProvider(
	deps: CoreServerSetupDeps,
	integration: GitHubIntegration,
	options: { now?: () => number } = {},
) {
	const due = createPollSchedule();
	const accepted = new Map<string, string>();
	return deps.polling.create({
		id: "github",
		pollInterval: () => "5s",
		isEnabled: () => true,
		defaultIntervalMs: 5_000,
		async pollOnce() {
			const result = emptyPollResult();
			const report = createExternalSourcePollReporter(deps.externalSources, result);
			for (const armed of deps.externalSources.listArmed(GITHUB_PR_STATE_KIND)) {
				const config = parse(armed.resolved);
				if (!config) {
					result.errors.push(`${armed.id}:invalid_config`);
					continue;
				}
				if (config.disabled) continue;
				const key = `${armed.instanceId}:${armed.id}:${armed.generation ?? ""}`;
				const now = options.now?.() ?? Date.now();
				if (!due(key, config.pollInterval, now)) continue;
				try {
					const client = integration.client(config.profile);
					const pr = await client.getPullRequest(config.owner, config.repo, config.prNumber);
					if (!config.eventKinds || config.eventKinds.includes("merge_conflict")) {
						const conflict = conflictEvidence(config, pr, "github");
						// GitHub's PR base SHA can lag the branch even while its state is behind.
						if (conflict?.reason === "behind") {
							const branch = await client.getCommit(config.owner, config.repo, conflict.baseBranch);
							conflict.baseSha = branch.sha;
						}
						await report.observe(armed, {
							observation: {
								...(conflict
									? describeConflict({ conflict })
									: {
											summary: `PR #${pr.number} mergeability: ${pr.mergeable == null ? "unresolved" : (pr.mergeable_state ?? String(pr.mergeable))}`,
										}),
								observedAt: new Date(now).toISOString(),
								subject: `${config.owner}/${config.repo}#${pr.number}`,
								revision: `${pr.head.sha}:${conflict?.baseSha ?? pr.base.sha}`,
							},
						});
						if (
							conflict &&
							conflictKey(conflict) !== config.lastConflictKey &&
							accepted.get(key) !== conflictKey(conflict) &&
							deps.externalSources
								.listArmed(GITHUB_PR_STATE_KIND)
								.some((current) => sameSubscription(armed, current))
						) {
							if (
								await report.fire(
									armed,
									{ kind: "merge_conflict", conflict },
									conflictKey(conflict),
								)
							)
								accepted.set(key, conflictKey(conflict));
							continue;
						}
						if (config.eventKinds?.length === 1) continue;
					}
					let event: Record<string, unknown> | null = null;
					let mergeKey = "";
					if (pr.merged || pr.state === "closed") {
						event = {
							kind: pr.merged ? "merged" : "closed",
							pullRequest: pr,
						};
						mergeKey = `terminal:${pr.number}:${pr.merged}`;
					} else {
						const readsFeedback = !config.eventKinds || config.eventKinds.includes("feedback");
						const readsChecks = !config.eventKinds || config.eventKinds.includes("checks");
						const [feedback, checks] = await Promise.all([
							readsFeedback
								? client.listPullRequestFeedback(config.owner, config.repo, config.prNumber)
								: Promise.resolve([]),
							readsChecks || (deps.externalSources.observe && armed.generation)
								? client
										.getCheckSummary(config.owner, config.repo, config.headSha)
										.catch(async (error) => {
											await report.observe(armed, {
												refreshError:
													error instanceof Error ? error.message : "Checks refresh failed",
											});
											if (readsChecks) throw error;
											return null;
										})
								: Promise.resolve(null),
						]);
						if (checks && deps.externalSources.observe && armed.generation) {
							const description = describeGitHubEvent({ kind: "checks", checks });
							await report.observe(armed, {
								observation: {
									...description,
									observedAt: new Date(now).toISOString(),
									subject: `${config.owner}/${config.repo}#${config.prNumber}`,
									revision: checks.headSha,
								},
							});
						}
						const unseen = feedback.filter(
							(item) => item.id > config.feedbackCursor && item.author !== client.profile.botLogin,
						);
						if (unseen.length) {
							const feedbackCursor = Math.max(...unseen.map((item) => item.id));
							event = { kind: "feedback", feedback, feedbackCursor };
							mergeKey = `feedback:${feedbackCursor}`;
						} else if (readsChecks && checks && checks.status !== "pending") {
							event = { kind: "checks", checks };
							mergeKey = `checks:${checks.headSha}:${checks.status}`;
						}
					}
					if (
						!event ||
						(config.eventKinds &&
							!config.eventKinds.includes(
								String(event.kind) as (typeof config.eventKinds)[number],
							)) ||
						(event.kind === "checks" &&
							config.checkStatuses &&
							!config.checkStatuses.includes(
								(event.checks as { status: "pending" | "success" | "failure" }).status,
							))
					)
						continue;
					if (
						!deps.externalSources
							.listArmed(GITHUB_PR_STATE_KIND)
							.some((current) => sameSubscription(armed, current))
					)
						continue;
					await report.fire(armed, event, mergeKey);
				} catch (error) {
					await report.observe(armed, {
						refreshError: error instanceof Error ? error.message : "PR refresh failed",
					});
					result.errors.push(
						`${armed.id}:${error instanceof Error ? error.message : "poll_failed"}`,
					);
				}
			}
			for (const armed of deps.externalSources.listArmed(GITHUB_RELEASE_KIND)) {
				const config = asUnknownRecord(armed.resolved) ?? {};
				if (
					typeof config.profile !== "string" ||
					typeof config.owner !== "string" ||
					typeof config.repo !== "string" ||
					typeof config.mergeSha !== "string"
				)
					continue;
				if (config.disabled === true) continue;
				const key = `${armed.instanceId}:${armed.id}:${armed.generation ?? ""}`;
				const now = options.now?.() ?? Date.now();
				if (!due(key, typeof config.pollInterval === "string" ? config.pollInterval : "30s", now))
					continue;
				try {
					const client = integration.client(config.profile);
					for (const release of await client.listReleases(config.owner, config.repo)) {
						if (release.draft || release.prerelease) continue;
						const commit = await client.getCommit(config.owner, config.repo, release.tag_name);
						if (!(await client.isAncestor(config.owner, config.repo, config.mergeSha, commit.sha)))
							continue;
						await report.fire(
							armed,
							{ release, commitSha: commit.sha },
							`${release.id}:${commit.sha}`,
						);
						break;
					}
				} catch (error) {
					result.errors.push(
						`${armed.id}:${error instanceof Error ? error.message : "poll_failed"}`,
					);
				}
			}
			return result;
		},
	});
}
