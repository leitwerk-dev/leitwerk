import { asUnknownRecord } from "@leitwerk-dev/domain";
import {
	type CoreServerSetupDeps,
	defineProcessWatcherSource,
	parseProcessWatcherLaunchModelConfig,
} from "@leitwerk-dev/process-sdk";
import { type emptyPollResult, parseDurationMs } from "@leitwerk-dev/watcher-utils";
import type { GitLabIntegration } from "./capability.js";
import type { GitLabIssue, GitLabProject } from "./client.js";
import { type GitLabSelection, parseGitLabSelection, selectGitLabProjects } from "./selection.js";
export interface GitLabIssueWatcherConfig extends GitLabSelection {
	profile: string;
	pollInterval: string;
	labels: { trigger: string; done: string };
}
export interface GitLabIssueWatcherEvent {
	profile: string;
	repository: GitLabProject;
	issue: GitLabIssue;
	labels: { trigger: string; done: string };
}
export const gitlabIssueExternalId = (origin: string, projectId: number, iid: number) =>
	`gitlab:${origin}:${projectId}#${iid}`;
export const gitlabIssueWatcherSource = defineProcessWatcherSource<
	GitLabIssueWatcherConfig,
	GitLabIssueWatcherEvent
>({
	id: "@leitwerk-dev/gitlab.issue",
	label: "GitLab issue",
	parseConfig(raw) {
		const c = asUnknownRecord(raw);
		if (!c || typeof c.enabled !== "boolean") throw new Error("GitLab watcher requires enabled");
		const text = (value: unknown, name: string) => {
			if (typeof value !== "string" || !value.trim())
				throw new Error(`GitLab watcher requires ${name}`);
			return value.trim();
		};
		const labels = asUnknownRecord(c.labels) ?? {};
		const trigger = text(labels.trigger, "labels.trigger");
		const done = text(labels.done, "labels.done");
		if (trigger === done || trigger.includes(",") || done.includes(","))
			throw new Error("GitLab trigger/done labels must be distinct and contain no comma");
		const pollInterval = text(c.poll_interval ?? "30s", "poll_interval");
		if (parseDurationMs(pollInterval, -1) <= 0) throw new Error("Invalid GitLab polling interval");
		return {
			enabled: c.enabled,
			config: {
				...parseGitLabSelection(c),
				profile: text(c.profile, "profile"),
				pollInterval,
				labels: { trigger, done },
			},
			launchModelConfig: parseProcessWatcherLaunchModelConfig(c.launch),
		};
	},
	presentConfig(c) {
		return {
			targetSummary: `Profile ${c.profile} · trigger ${c.labels.trigger}`,
			details: [
				{ label: "Projects", value: c.projects.include.join(", ") || "selected groups" },
				{ label: "Groups", value: c.groups.include.join(", ") || "none" },
			],
		};
	},
});
export function createGitLabIssueDiscovery(
	deps: CoreServerSetupDeps,
	integration: GitLabIntegration,
	now: () => number,
) {
	const due = new Map<string, number>();
	return async (result: ReturnType<typeof emptyPollResult>) => {
		for (const watcher of deps.processWatchers?.listBySource(gitlabIssueWatcherSource) ?? []) {
			if (!watcher.enabled) continue;
			const key = `${watcher.processId}:${watcher.watcherId}`;
			const c = watcher.config;
			if ((due.get(key) ?? 0) > now()) continue;
			due.set(key, now() + parseDurationMs(c.pollInterval, 30000));
			const client = integration.client(c.profile);
			for (const repository of await selectGitLabProjects(client, c))
				for (const issue of await client.listIssues(repository.id)) {
					if (
						issue.state !== "opened" ||
						!issue.labels.includes(c.labels.trigger) ||
						issue.labels.includes(c.labels.done)
					)
						continue;
					const id = gitlabIssueExternalId(client.baseUrl, repository.id, issue.iid);
					if (deps.processes.listAll().some((p) => p.externalId === id)) {
						result.skipped.push(id);
						continue;
					}
					const guarded = {
						...watcher,
						async resolveLaunchAttempt(...args: Parameters<typeof watcher.resolveLaunchAttempt>) {
							const attempt = await watcher.resolveLaunchAttempt(...args);
							if (!attempt) return null;
							return {
								...attempt,
								preparationChecks: [
									...attempt.preparationChecks,
									{
										id: "gitlab-issue-eligibility",
										label: "Recheck GitLab source issue",
										async run() {
											const fresh = await client.getIssue(repository.id, issue.iid);
											if (
												fresh.state !== "opened" ||
												!fresh.labels.includes(c.labels.trigger) ||
												fresh.labels.includes(c.labels.done)
											)
												throw new Error("GitLab source issue eligibility changed before launch");
										},
									},
								],
							};
						},
					};
					const launched = await deps.launchRuns.startWatcher(
						guarded,
						{ profile: c.profile, repository, issue, labels: c.labels },
						{ idempotencyKey: id },
					);
					if (launched.error) result.errors.push(`${id}:launch_failed`);
					else if (launched.process) result.created.push(id);
					else result.skipped.push(id);
				}
		}
	};
}
