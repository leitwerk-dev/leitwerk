import {
	defineProcessWatcherSource,
	parseProcessWatcherLaunchModelConfig,
} from "@leitwerk-dev/process-sdk";
import { parseDurationMs } from "@leitwerk-dev/watcher-utils";
import type { GitHubIssue, GitHubRepository } from "./client.js";

export interface GitHubIssueWatcherConfig {
	profile: string;
	pollInterval: string;
	repositories: {
		include: readonly string[];
		exclude: readonly string[];
	};
	labels: {
		trigger: string;
		done: string;
	};
}

export interface GitHubIssueWatcherEvent {
	authorization: { actor: string; eventId: number };
	profile: string;
	repository: GitHubRepository;
	issue: GitHubIssue;
	labels: {
		trigger: string;
		done: string;
	};
}

function record(value: unknown, subject: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${subject} must be an object`);
	}
	return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, path: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`${path} must be a non-empty string`);
	}
	return value.trim();
}

function repositoryNames(value: unknown, path: string): readonly string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
	return value.map((candidate, index) => {
		const name = nonEmptyString(candidate, `${path}[${index}]`);
		if (!/^[^/\s]+\/[^/\s]+$/.test(name)) {
			throw new Error(`${path}[${index}] must use owner/name format`);
		}
		return name;
	});
}

export const githubIssueWatcherSource = defineProcessWatcherSource<
	GitHubIssueWatcherConfig,
	GitHubIssueWatcherEvent
>({
	id: "@leitwerk-public/github.issue",
	label: "GitHub issue",
	parseConfig(raw) {
		const config = record(raw, "watcher config");
		if (config.type !== undefined && config.type !== "github_issue") {
			throw new Error("type must be 'github_issue' when specified");
		}
		if (typeof config.enabled !== "boolean") {
			throw new Error("enabled must be a boolean");
		}
		const pollInterval = nonEmptyString(config.poll_interval, "poll_interval");
		if (parseDurationMs(pollInterval, -1, { allowHours: true }) <= 0) {
			throw new Error("poll_interval must be a positive duration");
		}
		const labels = record(config.labels, "labels");
		const repositories =
			config.repositories === undefined ? {} : record(config.repositories, "repositories");
		const parsed = {
			profile: nonEmptyString(config.profile, "profile"),
			pollInterval,
			repositories: {
				include: repositoryNames(repositories.include, "repositories.include"),
				exclude: repositoryNames(repositories.exclude, "repositories.exclude"),
			},
			labels: {
				trigger: nonEmptyString(labels.trigger, "labels.trigger"),
				done: nonEmptyString(labels.done, "labels.done"),
			},
		};
		if (parsed.labels.trigger === parsed.labels.done)
			throw new Error("Trigger and done labels must differ");
		return {
			config: parsed,
			enabled: config.enabled,
			launchModelConfig: parseProcessWatcherLaunchModelConfig(config.launch),
		};
	},
	presentConfig(config) {
		return {
			targetSummary: `Profile ${config.profile} · trigger ${config.labels.trigger}`,
			details: [
				{ label: "Profile", value: config.profile },
				{
					label: "Included repositories",
					value: config.repositories.include.join(", ") || "all",
				},
				{
					label: "Excluded repositories",
					value: config.repositories.exclude.join(", ") || "none",
				},
				{ label: "Trigger label", value: config.labels.trigger },
				{ label: "Done label", value: config.labels.done },
				{ label: "Poll interval", value: config.pollInterval },
			],
		};
	},
});
