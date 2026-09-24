import { conflictEvidence, createConflictReporter } from "@leitwerk-dev/coding/repository-rebase";
import { asUnknownRecord } from "@leitwerk-dev/domain";
import {
	type CoreServerSetupDeps,
	createExternalSourcePollReporter,
	type ExternalSourceArmingLike,
	matchesRepository as matchesConfiguredRepository,
	parseRepositoryFeedbackConfig as parseFeedbackConfig,
	parseRepositoryIssueCancelledConfig as parseIssueCancelledConfig,
	parseRepositoryPullRequestConfig as parsePrConfig,
	type RegisteredProcessWatcherLike,
	repositoryFeedbackBatch,
} from "@leitwerk-dev/process-sdk";
import { createPollSchedule, emptyPollResult } from "@leitwerk-dev/watcher-utils";
import type { ForgejoIntegration } from "./capability.js";
import type { ForgejoIssue, ForgejoRepository } from "./client.js";
import {
	FORGEJO_ISSUE_CANCELLED_KIND,
	FORGEJO_PR_CONFLICT_KIND,
	FORGEJO_PR_FEEDBACK_KIND,
	FORGEJO_PR_TERMINAL_KIND,
} from "./external.js";
import {
	type ForgejoIssueWatcherConfig,
	type ForgejoIssueWatcherEvent,
	forgejoIssueWatcherSource,
} from "./issue-watcher.js";

function hasLabel(issue: ForgejoIssue, label: string): boolean {
	return issue.labels.some((candidate) => candidate.name === label);
}

function externalId(repo: ForgejoRepository, issue: ForgejoIssue): string {
	return `forgejo:${repo.full_name}#${issue.number}`;
}

export { matchesConfiguredRepository };

export function createForgejoProvider(
	deps: CoreServerSetupDeps,
	integration: ForgejoIntegration,
	watcherSource = forgejoIssueWatcherSource,
	options: { now?: () => number } = {},
) {
	const due = createPollSchedule(options.now);
	const reportConflict = createConflictReporter(FORGEJO_PR_CONFLICT_KIND);

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
		const report = createExternalSourcePollReporter(deps.externalSources, result);
		for (const armed of deps.externalSources.listArmed(FORGEJO_PR_CONFLICT_KIND)) {
			const base = parsePrConfig(armed.resolved);
			const raw = asUnknownRecord(armed.resolved) ?? {};
			if (!base || base.disabled || typeof raw.headSha !== "string") continue;
			const key = `${armed.instanceId}:${armed.id}:${armed.generation ?? ""}`;
			if (!due(key, base.pollInterval ?? "30s")) continue;
			try {
				const pr = await integration
					.client(base.profile)
					.getPullRequest(base.owner, base.repo, base.prNumber);
				const conflict = conflictEvidence({ ...base, headSha: raw.headSha }, pr, "forgejo");
				await reportConflict(report, armed, conflict, raw.lastConflictKey, {
					summary: `PR #${pr.number} mergeability: ${pr.mergeable == null ? "unresolved" : String(pr.mergeable)}`,
					observedAt: new Date(options.now?.() ?? Date.now()).toISOString(),
					subject: `${base.owner}/${base.repo}#${pr.number}`,
					revision: `${pr.head.sha}:${pr.base.sha}`,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : "PR refresh failed";
				result.errors.push(`${armed.id}:${message}`);
				await report.observe(armed, { refreshError: message });
			}
		}

		async function poll<C extends { pollInterval?: string; disabled?: boolean }>(
			kind: string,
			parse: (value: unknown) => C | null,
			read: (config: C, armed: ExternalSourceArmingLike) => Promise<void>,
		) {
			await report.poll(kind, async (armed) => {
				const config = parse(armed.resolved);
				if (!config || !due(`${armed.instanceId}:${armed.id}`, config.pollInterval ?? "30s"))
					return;
				if (!config.disabled) await read(config, armed);
			});
		}
		await poll(FORGEJO_ISSUE_CANCELLED_KIND, parseIssueCancelledConfig, async (config, armed) => {
			const issue = await integration
				.client(config.profile)
				.getIssue(config.owner, config.repo, config.issueNumber);
			const reason =
				issue.state === "closed"
					? "issue_closed"
					: hasLabel(issue, config.triggerLabel)
						? null
						: "trigger_label_removed";
			if (reason) await report.fire(armed, { issue, reason }, `${issue.number}:${reason}`);
		});
		await poll(FORGEJO_PR_TERMINAL_KIND, parsePrConfig, async (config, armed) => {
			const pr = await integration
				.client(config.profile)
				.getPullRequest(config.owner, config.repo, config.prNumber);
			if (!pr.merged && pr.state !== "closed") return;
			const outcome = pr.merged ? "merged" : "closed";
			if (config.terminalOutcome && config.terminalOutcome !== outcome) return;
			await report.fire(armed, { pullRequest: pr }, `${pr.number}:${outcome}`);
		});
		await poll(FORGEJO_PR_FEEDBACK_KIND, parseFeedbackConfig, async (config, armed) => {
			const client = integration.client(config.profile);
			const unseen = (
				await client.listPullRequestFeedback(config.owner, config.repo, config.prNumber)
			).filter(
				(item) => item.author !== client.profile.botLogin && item.id > config[`${item.kind}Cursor`],
			);
			const batch = repositoryFeedbackBatch(unseen, config, options.now?.() ?? Date.now());
			if (batch) await report.fire(armed, batch.event, batch.mergeKey);
		});
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
