import {
	defineExternalActionSource,
	type ExternalEventDescription,
} from "@leitwerk-dev/process-sdk";
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
		pullRequest?: { number: number; merged?: boolean; state?: string };
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
			value.kind === "merged" || value.kind === "closed" || value.pullRequest
				? `PR #${value.pullRequest?.number} ${value.kind ?? (value.pullRequest?.merged ? "merged" : "closed")}`
				: value.kind === "feedback"
					? "Pull request feedback received"
					: "GitHub event received",
	};
}

export const GITHUB_PR_TERMINAL_KIND = "@leitwerk-public/github.pr_terminal";
export const GITHUB_PR_FEEDBACK_KIND = "@leitwerk-public/github.pr_feedback";
export const GITHUB_ISSUE_CANCELLED_KIND = "@leitwerk-public/github.issue_cancelled";

export interface GitHubPullRequestTerminalSourceConfig {
	profile: string;
	owner: string;
	repo: string;
	prNumber: number;
	pollInterval?: string;
	terminalOutcome?: "merged" | "closed";
	disabled?: boolean;
}

export interface GitHubFeedbackSourceConfig extends GitHubPullRequestTerminalSourceConfig {
	conversationCursor: number;
	reviewCursor: number;
	inlineCursor: number;
	quietPeriodMs: number;
}

export interface GitHubIssueCancelledSourceConfig {
	profile: string;
	owner: string;
	repo: string;
	issueNumber: number;
	triggerLabel: string;
	pollInterval?: string;
}

export const GITHUB_CHECKS_KIND = "@leitwerk-public/github.checks";

export const githubExternal = {
	checks: defineExternalActionSource<{
		profile: string;
		owner: string;
		repo: string;
		prNumber: number;
		headSha: string;
	}>({
		kind: GITHUB_CHECKS_KIND,
		describeEvent: describeGitHubEvent,
		label: "GitHub Actions failures",
	}),
	issueCancelled: defineExternalActionSource<GitHubIssueCancelledSourceConfig>({
		kind: GITHUB_ISSUE_CANCELLED_KIND,
		describeEvent: () => ({ summary: "Source issue cancelled" }),
		label: "GitHub source issue cancelled",
		description: "Fires when the source issue closes or loses its trigger label",
	}),
	pullRequestTerminal: defineExternalActionSource<GitHubPullRequestTerminalSourceConfig>({
		kind: GITHUB_PR_TERMINAL_KIND,
		describeEvent: describeGitHubEvent,
		label: "GitHub pull request merged or closed",
		description: "Fires when the tracked pull request reaches a terminal state",
	}),
	pullRequestFeedback: defineExternalActionSource<GitHubFeedbackSourceConfig>({
		kind: GITHUB_PR_FEEDBACK_KIND,
		describeEvent: () => ({ summary: "Pull request feedback received" }),
		label: "GitHub pull request feedback",
		description: "Fires after unseen human feedback has been quiet long enough to batch",
	}),
	releaseContaining: defineExternalActionSource<GitHubReleaseSourceConfig>({
		kind: GITHUB_RELEASE_KIND,
		label: "Published GitHub release",
		description: "Fires when a published release contains the tracked merge commit",
	}),
	pullRequestState: defineExternalActionSource<GitHubPullRequestSourceConfig>({
		kind: GITHUB_PR_STATE_KIND,
		describeEvent: describeGitHubEvent,
		label: "GitHub pull request state",
		description: "Fires for failed or successful checks, review feedback, and terminal PR state",
	}),
};
