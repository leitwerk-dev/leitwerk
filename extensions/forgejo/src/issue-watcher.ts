import {
	defineProcessWatcherSource,
	parseRepositoryIssueWatcherConfig,
	presentRepositoryIssueWatcherConfig,
	type RepositoryIssueWatcherConfig,
} from "@leitwerk-dev/process-sdk";
import type { ForgejoIssue, ForgejoRepository } from "./client.js";

/** @public */
export interface ForgejoIssueWatcherConfig extends RepositoryIssueWatcherConfig {}

/** @public */
export interface ForgejoIssueWatcherEvent {
	/** @internal */
	profile: string;
	/** @internal */
	repository: ForgejoRepository;
	/** @internal */
	issue: ForgejoIssue;
	/** @internal */
	labels: {
		/** @internal */
		trigger: string;
		/** @internal */
		done: string;
	};
}

/** @public */
export const forgejoIssueWatcherSource = defineProcessWatcherSource<
	ForgejoIssueWatcherConfig,
	ForgejoIssueWatcherEvent
>({
	id: "@leitwerk-private/forgejo.issue",
	label: "Forgejo issue",
	parseConfig: (raw) => parseRepositoryIssueWatcherConfig(raw, "forgejo_issue"),
	presentConfig: presentRepositoryIssueWatcherConfig,
});
