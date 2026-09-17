import {
	defineProcessWatcherSource,
	parseRepositoryIssueWatcherConfig,
	presentRepositoryIssueWatcherConfig,
	type RepositoryIssueWatcherConfig,
} from "@leitwerk-dev/process-sdk";
import type { GitHubIssue, GitHubRepository } from "./client.js";

export interface GitHubIssueWatcherConfig extends RepositoryIssueWatcherConfig {}

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

export const githubIssueWatcherSource = defineProcessWatcherSource<
	GitHubIssueWatcherConfig,
	GitHubIssueWatcherEvent
>({
	id: "@leitwerk-public/github.issue",
	label: "GitHub issue",
	parseConfig: (raw) => parseRepositoryIssueWatcherConfig(raw, "github_issue", true),
	presentConfig: presentRepositoryIssueWatcherConfig,
});
