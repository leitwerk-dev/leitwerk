import {
	defineProcessWatcherSource,
	parseRepositoryIssueWatcherConfig,
	presentRepositoryIssueWatcherConfig,
	type RepositoryIssueWatcherConfig,
} from "@leitwerk-dev/process-sdk";
import type { ForgejoIssue, ForgejoRepository } from "./client.js";

export interface ForgejoIssueWatcherConfig extends RepositoryIssueWatcherConfig {}

export interface ForgejoIssueWatcherEvent {
	profile: string;
	repository: ForgejoRepository;
	issue: ForgejoIssue;
	labels: {
		trigger: string;
		done: string;
	};
}

export const forgejoIssueWatcherSource = defineProcessWatcherSource<
	ForgejoIssueWatcherConfig,
	ForgejoIssueWatcherEvent
>({
	id: "@leitwerk-private/forgejo.issue",
	label: "Forgejo issue",
	parseConfig: (raw) => parseRepositoryIssueWatcherConfig(raw, "forgejo_issue"),
	presentConfig: presentRepositoryIssueWatcherConfig,
});
