import type { ExternalActionSource, ExternalEventDescription } from "@leitwerk-dev/process-sdk";
import { describeConflict } from "@leitwerk-dev/repository-rebase";

export const GITHUB_PR_STATE_KIND = "@leitwerk-private/github.pr_state";

export interface GitHubPullRequestSourceConfig {
	profile: string;
	owner: string;
	repo: string;
	prNumber: number;
	headSha: string;
	feedbackCursor: number;
	lastConflictKey?: string | null;
	pollInterval?: string;
	disabled?: boolean;
	eventKinds?: Array<"checks" | "feedback" | "merged" | "closed" | "merge_conflict">;
	checkStatuses?: Array<"pending" | "success" | "failure">;
}

export const GITHUB_RELEASE_KIND = "@leitwerk-private/github.release";

export interface GitHubReleaseSourceConfig {
	profile: string;
	owner: string;
	repo: string;
	mergeSha: string;
	pollInterval?: string;
	disabled?: boolean;
}

export function describeGitHubEvent(event: unknown): ExternalEventDescription {
	const value = event as {
		kind?: string;
		checks?: {
			headSha: string;
			status: string;
			failed: Array<{ name: string; url: string | null }>;
		};
		pullRequest?: { number: number };
	};
	if (value.kind === "merge_conflict") return describeConflict(event);
	if (value.checks) {
		const checks = value.checks;
		return {
			summary: `Checks ${checks.status} on ${checks.headSha}${checks.failed.length ? `: ${checks.failed.map((check) => check.name).join(", ")}` : ""}`,
			links: checks.failed.flatMap((check, index) =>
				check.url
					? [{ id: `check-${index}`, label: check.name, url: check.url, kind: "pipeline" as const }]
					: [],
			),
		};
	}
	return {
		summary:
			value.kind === "merged" || value.kind === "closed"
				? `PR #${value.pullRequest?.number} ${value.kind}`
				: value.kind === "feedback"
					? "Pull request feedback received"
					: "GitHub event received",
	};
}

export const githubExternal = {
	releaseContaining<TParams, TState>(
		resolve: (ctx: { params: TParams; state: TState }) => GitHubReleaseSourceConfig,
	): ExternalActionSource<TParams, TState> {
		return {
			kind: GITHUB_RELEASE_KIND,
			label: "Published GitHub release",
			description: "Fires when a published release contains the tracked merge commit",
			config: {},
			inputMode: "none",
			resolve,
		};
	},
	pullRequestState<TParams, TState>(
		resolve: (ctx: { params: TParams; state: TState }) => GitHubPullRequestSourceConfig,
	): ExternalActionSource<TParams, TState> {
		return {
			kind: GITHUB_PR_STATE_KIND,
			describeEvent: describeGitHubEvent,
			label: "GitHub pull request state",
			description: "Fires for failed or successful checks, review feedback, and terminal PR state",
			config: {},
			inputMode: "none",
			resolve,
		};
	},
};
