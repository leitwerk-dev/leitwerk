import {
	defineProcessWatcherSource,
	parseRepositoryIssueWatcherConfig,
	presentRepositoryIssueWatcherConfig,
	type RepositoryIssueWatcherConfig,
} from "@leitwerk-dev/process-sdk";
import type { GitHubIssue, GitHubRepository } from "./client.js";

/** @public */
export interface GitHubIssueWatcherConfig extends RepositoryIssueWatcherConfig {}

/** @public */
export interface GitHubIssueWatcherEvent {
	/** @public */
	authorization: {
		/** @internal */
		actor: string;
		/** @internal */
		eventId: number;
	};
	/** @public */
	profile: string;
	/** @public */
	repository: GitHubRepository;
	/** @public */
	issue: GitHubIssue;
	/** @public */
	labels: {
		/** @public */
		trigger: string;
		/** @public */
		done: string;
	};
}

/** @public */
export const githubIssueWatcherSource = defineProcessWatcherSource<
	GitHubIssueWatcherConfig,
	GitHubIssueWatcherEvent
>({
	id: "@leitwerk-public/github.issue",
	label: "GitHub issue",
	parseConfig: (raw) => parseRepositoryIssueWatcherConfig(raw, "github_issue", true),
	presentConfig: presentRepositoryIssueWatcherConfig,
});
