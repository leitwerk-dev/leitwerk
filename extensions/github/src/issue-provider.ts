import type { CoreServerSetupDeps, RegisteredProcessWatcherLike } from "@leitwerk-dev/process-sdk";
import { sameSubscription } from "@leitwerk-dev/repository-rebase";
import { createPollSchedule, type emptyPollResult } from "@leitwerk-dev/watcher-utils";
import type { GitHubIntegration } from "./capability.js";
import type { GitHubIssue, GitHubRepository } from "./client.js";
import {
	describeGitHubEvent,
	GITHUB_CHECKS_KIND,
	GITHUB_ISSUE_CANCELLED_KIND,
	GITHUB_PR_FEEDBACK_KIND,
	GITHUB_PR_TERMINAL_KIND,
	type GitHubFeedbackSourceConfig,
	type GitHubIssueCancelledSourceConfig,
	type GitHubPullRequestTerminalSourceConfig,
} from "./external.js";
import {
	type GitHubIssueWatcherConfig,
	type GitHubIssueWatcherEvent,
	githubIssueWatcherSource,
} from "./issue-watcher.js";
import { githubPollReporter } from "./poll-report.js";

function object(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function hasLabel(issue: GitHubIssue, label: string): boolean {
	return issue.labels.some((candidate) => candidate.name === label);
}

function externalId(repo: GitHubRepository, issue: GitHubIssue): string {
	return `github:${repo.full_name}#${issue.number}`;
}

export function matchesConfiguredRepository(
	config: Pick<GitHubIssueWatcherConfig, "repositories">,
	repository: GitHubRepository,
): boolean {
	const fullName = repository.full_name;
	const { include = [], exclude = [] } = config.repositories ?? {};
	if (exclude.includes(fullName)) return false;
	return include.length === 0 || include.includes(fullName);
}

function parsePrConfig(value: unknown): GitHubPullRequestTerminalSourceConfig | null {
	const config = object(value);
	if (
		typeof config.profile !== "string" ||
		typeof config.owner !== "string" ||
		typeof config.repo !== "string" ||
		typeof config.prNumber !== "number"
	)
		return null;
	return {
		profile: config.profile,
		owner: config.owner,
		repo: config.repo,
		prNumber: config.prNumber,
		pollInterval: typeof config.pollInterval === "string" ? config.pollInterval : "30s",
		terminalOutcome:
			config.terminalOutcome === "merged" || config.terminalOutcome === "closed"
				? config.terminalOutcome
				: undefined,
		disabled: config.disabled === true,
	};
}

function parseFeedbackConfig(value: unknown): GitHubFeedbackSourceConfig | null {
	const base = parsePrConfig(value);
	const config = object(value);
	if (!base) return null;
	return {
		...base,
		conversationCursor:
			typeof config.conversationCursor === "number" ? config.conversationCursor : 0,
		reviewCursor: typeof config.reviewCursor === "number" ? config.reviewCursor : 0,
		inlineCursor: typeof config.inlineCursor === "number" ? config.inlineCursor : 0,
		quietPeriodMs: typeof config.quietPeriodMs === "number" ? config.quietPeriodMs : 120_000,
	};
}

function parseIssueCancelledConfig(value: unknown): GitHubIssueCancelledSourceConfig | null {
	const config = object(value);
	if (
		typeof config.profile !== "string" ||
		typeof config.owner !== "string" ||
		typeof config.repo !== "string" ||
		typeof config.issueNumber !== "number" ||
		typeof config.triggerLabel !== "string"
	)
		return null;
	return {
		profile: config.profile,
		owner: config.owner,
		repo: config.repo,
		issueNumber: config.issueNumber,
		triggerLabel: config.triggerLabel,
		pollInterval: typeof config.pollInterval === "string" ? config.pollInterval : "30s",
	};
}

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
		for (const armed of terminalArmings) {
			const config = parsePrConfig(armed.resolved);
			if (
				!config ||
				!due(
					`${armed.instanceId}:${armed.id}:${armed.generation ?? ""}`,
					config.pollInterval ?? "30s",
				)
			)
				continue;
			if (config.disabled) continue;
			try {
				const pr = await integration
					.client(config.profile)
					.getPullRequest(config.owner, config.repo, config.prNumber);
				if (!pr.merged && pr.state !== "closed") continue;
				if (
					!deps.externalSources
						.listArmed(GITHUB_PR_TERMINAL_KIND)
						.some((current) => sameSubscription(armed, current))
				)
					continue;
				terminalInstances.add(armed.instanceId);
				const outcome = pr.merged ? "merged" : "closed";
				if (config.terminalOutcome && config.terminalOutcome !== outcome) continue;
				await report.fire(
					armed,
					{ pullRequest: pr },
					`${pr.number}:${pr.merged ? "merged" : "closed"}`,
				);
			} catch (error) {
				await report.observe(armed, {
					refreshError: error instanceof Error ? error.message : "GitHub refresh failed",
				});
				result.errors.push(`${armed.id}:${error instanceof Error ? error.message : "poll_failed"}`);
			}
		}

		for (const armed of deps.externalSources.listArmed(GITHUB_CHECKS_KIND)) {
			if (terminalInstances.has(armed.instanceId)) continue;
			const config = object(armed.resolved);
			if (!due(`${armed.instanceId}:${armed.id}:${armed.generation ?? ""}`, "30s")) continue;
			try {
				const client = integration.client(String(config.profile));
				const pr = await client.getPullRequest(
					String(config.owner),
					String(config.repo),
					Number(config.prNumber),
				);
				if (pr.state !== "open" || pr.head.sha !== config.headSha) continue;
				const checks = await client.getCheckSummary(
					String(config.owner),
					String(config.repo),
					String(config.headSha),
				);
				if (checks.headSha !== config.headSha) continue;
				const refreshed = await client.getPullRequest(
					String(config.owner),
					String(config.repo),
					Number(config.prNumber),
				);
				if (refreshed.state !== "open" || refreshed.merged || refreshed.head.sha !== checks.headSha)
					continue;
				await report.observe(armed, {
					observation: {
						...describeGitHubEvent({ checks }),
						observedAt: new Date(now()).toISOString(),
						subject: `${config.owner}/${config.repo}#${config.prNumber}`,
						revision: checks.headSha,
					},
				});
				if (checks.status !== "failure") continue;
				await report.fire(
					armed,
					{ checks },
					`${checks.headSha}:${checks.failed.map((run) => run.url).join(":")}`,
				);
			} catch (error) {
				await report.observe(armed, {
					refreshError: error instanceof Error ? error.message : "GitHub refresh failed",
				});
				result.errors.push(
					`${armed.id}:${error instanceof Error ? error.message : "checks_failed"}`,
				);
			}
		}

		for (const armed of deps.externalSources.listArmed(GITHUB_ISSUE_CANCELLED_KIND)) {
			if (terminalInstances.has(armed.instanceId)) continue;
			const config = parseIssueCancelledConfig(armed.resolved);
			if (
				!config ||
				!due(
					`${armed.instanceId}:${armed.id}:${armed.generation ?? ""}`,
					config.pollInterval ?? "30s",
				)
			)
				continue;
			try {
				const issue = await integration
					.client(config.profile)
					.getIssue(config.owner, config.repo, config.issueNumber);
				const reason =
					issue.state === "closed"
						? "issue_closed"
						: hasLabel(issue, config.triggerLabel)
							? null
							: "trigger_label_removed";
				if (!reason) continue;
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
						continue;
					}
				}
				await report.fire(armed, { issue, reason }, `${issue.number}:${reason}`);
			} catch (error) {
				await report.observe(armed, {
					refreshError: error instanceof Error ? error.message : "GitHub refresh failed",
				});
				result.errors.push(`${armed.id}:${error instanceof Error ? error.message : "poll_failed"}`);
			}
		}
		for (const armed of deps.externalSources.listArmed(GITHUB_PR_FEEDBACK_KIND)) {
			if (terminalInstances.has(armed.instanceId)) continue;
			const config = parseFeedbackConfig(armed.resolved);
			if (
				!config ||
				!due(
					`${armed.instanceId}:${armed.id}:${armed.generation ?? ""}`,
					config.pollInterval ?? "30s",
				)
			)
				continue;
			if (config.disabled) continue;
			try {
				const client = integration.client(config.profile);
				const pr = await client.getPullRequest(config.owner, config.repo, config.prNumber);
				if (pr.merged || pr.state !== "open") continue;
				const candidates = (
					await client.listActionablePullRequestFeedback(config.owner, config.repo, config.prNumber)
				).filter((item) => {
					if (item.body?.includes("<!-- leitwerk-write:")) return false;
					if (item.kind === "conversation") return item.id > config.conversationCursor;
					if (item.kind === "review") return item.id > config.reviewCursor;
					return item.id > config.inlineCursor;
				});
				const unseen = candidates;

				if (!unseen.length) continue;
				const latest = Math.max(...unseen.map((item) => Date.parse(item.createdAt) || 0));
				if (now() - latest < config.quietPeriodMs) continue;
				const cursors = {
					conversationCursor: Math.max(
						config.conversationCursor,
						...unseen.filter((item) => item.kind === "conversation").map((item) => item.id),
					),
					reviewCursor: Math.max(
						config.reviewCursor,
						...unseen.filter((item) => item.kind === "review").map((item) => item.id),
					),
					inlineCursor: Math.max(
						config.inlineCursor,
						...unseen.filter((item) => item.kind === "inline").map((item) => item.id),
					),
				};
				await report.fire(
					armed,
					{
						feedbackIds: unseen.map((item) => ({
							kind: item.kind,
							id: item.id,
						})),
						cursors,
					},
					`${cursors.conversationCursor}:${cursors.reviewCursor}:${cursors.inlineCursor}`,
				);
			} catch (error) {
				await report.observe(armed, {
					refreshError: error instanceof Error ? error.message : "GitHub refresh failed",
				});
				result.errors.push(`${armed.id}:${error instanceof Error ? error.message : "poll_failed"}`);
			}
		}
	}

	return async (result: ReturnType<typeof emptyPollResult>) => {
		const watchers = (deps.processWatchers?.listAll() ?? []).filter(
			(
				watcher,
			): watcher is RegisteredProcessWatcherLike<
				GitHubIssueWatcherConfig,
				GitHubIssueWatcherEvent
			> => watcher.sourceId === githubIssueWatcherSource.id,
		);
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
