import type { CoreServerSetupDeps, RegisteredProcessWatcherLike } from "@leitwerk-dev/process-sdk";
import {
	conflictEvidence,
	conflictKey,
	describeConflict,
	sameSubscription,
} from "@leitwerk-dev/repository-rebase";
import { emptyPollResult, parseDurationMs } from "@leitwerk-dev/watcher-utils";
import type { ForgejoIntegration } from "./capability.js";
import type { ForgejoIssue, ForgejoRepository } from "./client.js";
import {
	FORGEJO_ISSUE_CANCELLED_KIND,
	FORGEJO_PR_CONFLICT_KIND,
	FORGEJO_PR_FEEDBACK_KIND,
	FORGEJO_PR_TERMINAL_KIND,
	type ForgejoFeedbackSourceConfig,
	type ForgejoIssueCancelledSourceConfig,
	type ForgejoPullRequestSourceConfig,
} from "./external.js";
import {
	type ForgejoIssueWatcherConfig,
	type ForgejoIssueWatcherEvent,
	forgejoIssueWatcherSource,
} from "./issue-watcher.js";

function object(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function hasLabel(issue: ForgejoIssue, label: string): boolean {
	return issue.labels.some((candidate) => candidate.name === label);
}

function externalId(repo: ForgejoRepository, issue: ForgejoIssue): string {
	return `forgejo:${repo.full_name}#${issue.number}`;
}

export function matchesConfiguredRepository(
	config: Pick<ForgejoIssueWatcherConfig, "repositories">,
	repository: ForgejoRepository,
): boolean {
	const fullName = repository.full_name;
	const { include = [], exclude = [] } = config.repositories ?? {};
	if (exclude.includes(fullName)) return false;
	return include.length === 0 || include.includes(fullName);
}

function parsePrConfig(value: unknown): ForgejoPullRequestSourceConfig | null {
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

function parseFeedbackConfig(value: unknown): ForgejoFeedbackSourceConfig | null {
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

function parseIssueCancelledConfig(value: unknown): ForgejoIssueCancelledSourceConfig | null {
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

export function createForgejoProvider(
	deps: CoreServerSetupDeps,
	integration: ForgejoIntegration,
	watcherSource = forgejoIssueWatcherSource,
	options: { now?: () => number } = {},
) {
	const dueAt = new Map<string, number>();
	const accepted = new Map<string, string>();
	const due = (key: string, interval: string) => {
		const now = options.now?.() ?? Date.now();
		if ((dueAt.get(key) ?? 0) > now) return false;
		dueAt.set(key, now + parseDurationMs(interval, 30_000));
		return true;
	};

	async function discover(
		watcher: RegisteredProcessWatcherLike<ForgejoIssueWatcherConfig, ForgejoIssueWatcherEvent>,
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
					if (!deps.launchRuns) throw new Error("Launch coordinator is unavailable");
					const launched = await deps.launchRuns.startWatcher(
						watcher,
						{
							profile: config.profile,
							repository: repo,
							issue,
							labels: config.labels,
						},
						{ idempotencyKey: id },
					);
					if (launched.error) result.errors.push(`${id}:${launched.error}`);
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
		for (const armed of deps.externalSources.listArmed(FORGEJO_PR_CONFLICT_KIND)) {
			const base = parsePrConfig(armed.resolved);
			const raw = object(armed.resolved);
			if (!base || base.disabled || typeof raw.headSha !== "string") continue;
			const key = `${armed.instanceId}:${armed.id}:${armed.generation ?? ""}`;
			if (!due(key, base.pollInterval ?? "30s")) continue;
			try {
				const pr = await integration
					.client(base.profile)
					.getPullRequest(base.owner, base.repo, base.prNumber);
				const conflict = conflictEvidence({ ...base, headSha: raw.headSha }, pr, "forgejo");
				if (deps.externalSources.observe && armed.generation)
					await deps.externalSources.observe({
						instanceId: armed.instanceId,
						armingId: armed.id,
						generation: armed.generation,
						observation: {
							...(conflict
								? describeConflict({ conflict })
								: {
										summary: `PR #${pr.number} mergeability: ${pr.mergeable == null ? "unresolved" : String(pr.mergeable)}`,
									}),
							observedAt: new Date(options.now?.() ?? Date.now()).toISOString(),
							subject: `${base.owner}/${base.repo}#${pr.number}`,
							revision: `${pr.head.sha}:${pr.base.sha}`,
						},
					});
				if (
					!conflict ||
					conflictKey(conflict) === raw.lastConflictKey ||
					accepted.get(key) === conflictKey(conflict) ||
					!deps.externalSources
						.listArmed(FORGEJO_PR_CONFLICT_KIND)
						.some((current) => sameSubscription(armed, current))
				)
					continue;
				const fired = await deps.externalSources.fire({
					instanceId: armed.instanceId,
					armingId: armed.id,
					event: { kind: "merge_conflict", conflict },
					mergeKey: conflictKey(conflict),
				});
				if (fired.ok) {
					accepted.set(key, conflictKey(conflict));
					result.created.push(armed.id);
				} else result.errors.push(`${armed.id}:fire_failed`);
			} catch (error) {
				const message = error instanceof Error ? error.message : "PR refresh failed";
				result.errors.push(`${armed.id}:${message}`);
				if (deps.externalSources.observe && armed.generation)
					await deps.externalSources.observe({
						instanceId: armed.instanceId,
						armingId: armed.id,
						generation: armed.generation,
						refreshError: message,
					});
			}
		}

		for (const armed of deps.externalSources.listArmed(FORGEJO_ISSUE_CANCELLED_KIND)) {
			const config = parseIssueCancelledConfig(armed.resolved);
			if (!config || !due(`${armed.instanceId}:${armed.id}`, config.pollInterval ?? "30s"))
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
				const fired = await deps.externalSources.fire({
					instanceId: armed.instanceId,
					armingId: armed.id,
					event: { issue, reason },
					mergeKey: `${issue.number}:${reason}`,
				});
				if (fired.ok) result.created.push(armed.id);
				else result.errors.push(`${armed.id}:fire_failed`);
			} catch (error) {
				result.errors.push(`${armed.id}:${error instanceof Error ? error.message : "poll_failed"}`);
			}
		}
		for (const armed of deps.externalSources.listArmed(FORGEJO_PR_TERMINAL_KIND)) {
			const config = parsePrConfig(armed.resolved);
			if (!config || !due(`${armed.instanceId}:${armed.id}`, config.pollInterval ?? "30s"))
				continue;
			if (config.disabled) continue;
			try {
				const pr = await integration
					.client(config.profile)
					.getPullRequest(config.owner, config.repo, config.prNumber);
				if (!pr.merged && pr.state !== "closed") continue;
				const outcome = pr.merged ? "merged" : "closed";
				if (config.terminalOutcome && config.terminalOutcome !== outcome) continue;
				const fired = await deps.externalSources.fire({
					instanceId: armed.instanceId,
					armingId: armed.id,
					event: { pullRequest: pr },
					mergeKey: `${pr.number}:${pr.merged ? "merged" : "closed"}`,
				});
				if (fired.ok) result.created.push(armed.id);
				else result.errors.push(`${armed.id}:fire_failed`);
			} catch (error) {
				result.errors.push(`${armed.id}:${error instanceof Error ? error.message : "poll_failed"}`);
			}
		}
		for (const armed of deps.externalSources.listArmed(FORGEJO_PR_FEEDBACK_KIND)) {
			const config = parseFeedbackConfig(armed.resolved);
			if (!config || !due(`${armed.instanceId}:${armed.id}`, config.pollInterval ?? "30s"))
				continue;
			if (config.disabled) continue;
			try {
				const client = integration.client(config.profile);
				const unseen = (
					await client.listPullRequestFeedback(config.owner, config.repo, config.prNumber)
				).filter((item) => {
					if (item.author === client.profile.botLogin) return false;
					if (item.kind === "conversation") return item.id > config.conversationCursor;
					if (item.kind === "review") return item.id > config.reviewCursor;
					return item.id > config.inlineCursor;
				});
				if (!unseen.length) continue;
				const latest = Math.max(...unseen.map((item) => Date.parse(item.createdAt) || 0));
				if ((options.now?.() ?? Date.now()) - latest < config.quietPeriodMs) continue;
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
				const fired = await deps.externalSources.fire({
					instanceId: armed.instanceId,
					armingId: armed.id,
					event: {
						feedbackIds: unseen.map((item) => ({
							kind: item.kind,
							id: item.id,
						})),
						cursors,
					},
					mergeKey: `${cursors.conversationCursor}:${cursors.reviewCursor}:${cursors.inlineCursor}`,
				});
				if (fired.ok) result.created.push(armed.id);
				else result.errors.push(`${armed.id}:fire_failed`);
			} catch (error) {
				result.errors.push(`${armed.id}:${error instanceof Error ? error.message : "poll_failed"}`);
			}
		}
	}

	return deps.polling.create({
		id: "forgejo",
		pollInterval: () => "5s",
		isEnabled: () => true,
		defaultIntervalMs: 5_000,
		async pollOnce() {
			const result = emptyPollResult();
			for (const watcher of deps.processWatchers?.listBySource(watcherSource) ?? []) {
				if (
					watcher.enabled &&
					due(`${watcher.processId}:${watcher.watcherId}`, watcher.config.pollInterval)
				)
					await discover(watcher, result);
			}
			await pollExternal(result);
			return result;
		},
	});
}
