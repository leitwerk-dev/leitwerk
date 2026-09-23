import { asUnknownRecord } from "@leitwerk-dev/domain";
import {
	type CoreServerSetupDeps,
	type ExternalSourceArmingLike,
	matchesRepository as matchesConfiguredRepository,
	parseRepositoryFeedbackConfig as parseFeedbackConfig,
	parseRepositoryIssueCancelledConfig as parseIssueCancelledConfig,
	parseRepositoryPullRequestConfig as parsePrConfig,
	type RegisteredProcessWatcherLike,
	repositoryFeedbackBatch,
} from "@leitwerk-dev/process-sdk";
import { createPollSchedule, type emptyPollResult } from "@leitwerk-dev/watcher-utils";
import type { GitHubIntegration } from "./capability.js";
import type { GitHubIssue, GitHubRepository } from "./client.js";
import {
	describeGitHubEvent,
	GITHUB_CHECKS_KIND,
	GITHUB_ISSUE_CANCELLED_KIND,
	GITHUB_PR_FEEDBACK_KIND,
	GITHUB_PR_TERMINAL_KIND,
} from "./external.js";
import {
	type GitHubIssueWatcherConfig,
	type GitHubIssueWatcherEvent,
	githubIssueWatcherSource,
} from "./issue-watcher.js";
import { githubPollReporter } from "./poll-report.js";

function hasLabel(issue: GitHubIssue, label: string): boolean {
	return issue.labels.some((candidate) => candidate.name === label);
}

function externalId(repo: GitHubRepository, issue: GitHubIssue): string {
	return `github:${repo.full_name}#${issue.number}`;
}

export { matchesConfiguredRepository };

export function createGitHubIssuePolling(
	deps: CoreServerSetupDeps,
	integration: GitHubIntegration,
	options: { now?: () => number } = {},
) {
	const now = options.now ?? Date.now;
	const due = createPollSchedule(now);

	async function discover(
		watcher: RegisteredProcessWatcherLike<GitHubIssueWatcherConfig, GitHubIssueWatcherEvent>,
		result: ReturnType<typeof emptyPollResult>,
	) {
		const config = watcher.config;
		const client = integration.client(config.profile);
		for (const repo of await client.listRepositories()) {
			if (!matchesConfiguredRepository(config, repo)) continue;
			for (const issue of await client.listOpenIssues(repo.owner.login, repo.name)) {
				if (!hasLabel(issue, config.labels.trigger) || hasLabel(issue, config.labels.done))
					continue;
				const id = externalId(repo, issue);
				try {
					if (deps.processes.listAll().some((process) => process.externalId === id)) {
						result.skipped.push(id);
						continue;
					}
					const authorized = await client.authorizedTrigger(
						repo.owner.login,
						repo.name,
						issue.number,
						config.labels.trigger,
						config.labels.done,
					);
					if (!authorized) {
						result.skipped.push(`${id}:unauthorized`);
						continue;
					}
					const event: GitHubIssueWatcherEvent = {
						profile: config.profile,
						repository: repo,
						issue: authorized.issue,
						authorization: {
							actor: authorized.actor,
							eventId: authorized.eventId,
						},
						labels: config.labels,
					};

					const guardedWatcher = {
						...watcher,
						async resolveLaunchAttempt(...args: Parameters<typeof watcher.resolveLaunchAttempt>) {
							const attempt = await watcher.resolveLaunchAttempt(...args);
							if (!attempt) return null;
							return {
								...attempt,
								preparationChecks: [
									...attempt.preparationChecks,
									{
										id: "github-trigger-authorization",
										label: "Check GitHub trigger authorization",
										async run() {
											const rechecked = await client.authorizedTrigger(
												repo.owner.login,
												repo.name,
												issue.number,
												config.labels.trigger,
												config.labels.done,
											);
											if (
												!rechecked ||
												rechecked.eventId !== authorized.eventId ||
												rechecked.actor !== authorized.actor
											)
												throw new Error("GitHub trigger authorization changed before launch");
										},
									},
								],
							};
						},
					};
					const launched = await deps.launchRuns.startWatcher(guardedWatcher, event, {
						idempotencyKey: id,
					});
					if (launched.error) result.errors.push(`${id}:launch_failed:${launched.error}`);
					else if (launched.process) result.created.push(id);
					else result.skipped.push(id);
				} catch (error) {
					result.errors.push(
						`${id}:${error instanceof Error ? error.message : "discovery_failed"}`,
					);
				}
			}
		}
	}

	async function pollExternal(result: ReturnType<typeof emptyPollResult>) {
		const report = githubPollReporter(deps.externalSources, result);
		const terminalArmings = deps.externalSources.listArmed(GITHUB_PR_TERMINAL_KIND);
		const terminalInstances = new Set<string>();
		async function poll<C extends { pollInterval?: string; disabled?: boolean }>(
			kind: string,
			parse: (value: unknown) => C | null,
			read: (config: C, armed: ExternalSourceArmingLike) => Promise<void>,
		) {
			const armings =
				kind === GITHUB_PR_TERMINAL_KIND ? terminalArmings : deps.externalSources.listArmed(kind);
			for (const armed of armings) {
				if (kind !== GITHUB_PR_TERMINAL_KIND && terminalInstances.has(armed.instanceId)) continue;
				const config = parse(armed.resolved);
				const key = `${armed.instanceId}:${armed.id}:${armed.generation ?? ""}`;
				if (!config || !due(key, config.pollInterval ?? "30s") || config.disabled) continue;
				try {
					await read(config, armed);
				} catch (error) {
					await report.observe(armed, {
						refreshError: error instanceof Error ? error.message : "GitHub refresh failed",
					});
					const fallback = kind === GITHUB_CHECKS_KIND ? "checks_failed" : "poll_failed";
					result.errors.push(`${armed.id}:${error instanceof Error ? error.message : fallback}`);
				}
			}
		}
		await poll(GITHUB_PR_TERMINAL_KIND, parsePrConfig, async (config, armed) => {
			const pr = await integration
				.client(config.profile)
				.getPullRequest(config.owner, config.repo, config.prNumber);
			if (!pr.merged && pr.state !== "closed") return;
			if (!report.isCurrent(GITHUB_PR_TERMINAL_KIND, armed)) return;
			terminalInstances.add(armed.instanceId);
			const outcome = pr.merged ? "merged" : "closed";
			if (config.terminalOutcome && config.terminalOutcome !== outcome) return;
			await report.fire(armed, { pullRequest: pr }, `${pr.number}:${outcome}`);
		});

		await poll(
			GITHUB_CHECKS_KIND,
			(value) => ({ pollInterval: "30s", config: asUnknownRecord(value) ?? {} }),
			async ({ config }, armed) => {
				const client = integration.client(String(config.profile));
				const pr = await client.getPullRequest(
					String(config.owner),
					String(config.repo),
					Number(config.prNumber),
				);
				if (pr.state !== "open" || pr.head.sha !== config.headSha) return;
				const checks = await client.getCheckSummary(
					String(config.owner),
					String(config.repo),
					String(config.headSha),
				);
				if (checks.headSha !== config.headSha) return;
				const refreshed = await client.getPullRequest(
					String(config.owner),
					String(config.repo),
					Number(config.prNumber),
				);
				if (refreshed.state !== "open" || refreshed.merged || refreshed.head.sha !== checks.headSha)
					return;
				await report.observe(armed, {
					observation: {
						...describeGitHubEvent({ checks }),
						observedAt: new Date(now()).toISOString(),
						subject: `${config.owner}/${config.repo}#${config.prNumber}`,
						revision: checks.headSha,
					},
				});
				if (checks.status !== "failure") return;
				const evidenceKey = `${checks.headSha}:${checks.failed.map((run) => run.url).join(":")}`;
				if (config.afterKey === evidenceKey) return;
				await report.fire(armed, { checks }, evidenceKey);
			},
		);

		await poll(GITHUB_ISSUE_CANCELLED_KIND, parseIssueCancelledConfig, async (config, armed) => {
			const issue = await integration
				.client(config.profile)
				.getIssue(config.owner, config.repo, config.issueNumber);
			const reason =
				issue.state === "closed"
					? "issue_closed"
					: hasLabel(issue, config.triggerLabel)
						? null
						: "trigger_label_removed";
			if (!reason) return;
			// A merge may close the issue between terminal polls. Preserve terminal
			// reconciliation instead of treating that close as cancellation.
			const terminal = terminalArmings
				.filter((candidate) => candidate.instanceId === armed.instanceId)
				.map((candidate) => parsePrConfig(candidate.resolved))
				.find((candidate) => candidate && !candidate.disabled);
			if (terminal) {
				const pr = await integration
					.client(terminal.profile)
					.getPullRequest(terminal.owner, terminal.repo, terminal.prNumber);
				if (pr.merged || pr.state === "closed") {
					terminalInstances.add(armed.instanceId);
					return;
				}
			}
			await report.fire(armed, { issue, reason }, `${issue.number}:${reason}`);
		});
		await poll(GITHUB_PR_FEEDBACK_KIND, parseFeedbackConfig, async (config, armed) => {
			const client = integration.client(config.profile);
			const pr = await client.getPullRequest(config.owner, config.repo, config.prNumber);
			if (pr.merged || pr.state !== "open") return;
			const unseen = (
				await client.listActionablePullRequestFeedback(config.owner, config.repo, config.prNumber)
			).filter((item) => item.id > config[`${item.kind}Cursor`]);

			const batch = repositoryFeedbackBatch(unseen, config, now());
			if (batch) await report.fire(armed, batch.event, batch.mergeKey);
		});
	}

	return async (result: ReturnType<typeof emptyPollResult>) => {
		const watchers = deps.processWatchers?.listBySource(githubIssueWatcherSource) ?? [];
		for (const watcher of watchers) {
			if (
				!watcher.enabled ||
				!due(`${watcher.processId}:${watcher.watcherId}`, watcher.config.pollInterval)
			)
				continue;
			try {
				await discover(watcher, result);
			} catch (error) {
				result.errors.push(
					`${watcher.processId}:${watcher.watcherId}:${error instanceof Error ? error.message : "discovery_failed"}`,
				);
			}
		}
		await pollExternal(result);
	};
}
