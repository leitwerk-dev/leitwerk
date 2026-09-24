import { describeConflict } from "@leitwerk-dev/coding/repository-rebase";
import {
	defineExternalActionSource,
	type ExternalEventDescription,
} from "@leitwerk-dev/process-sdk";

/** @internal */
export const GITHUB_PR_STATE_KIND = "@leitwerk-private/github.pr_state";

/** @public */
export interface GitHubPullRequestSourceConfig {
	/** @public */
	profile: string;
	/** @public */
	owner: string;
	/** @public */
	repo: string;
	/** @public */
	prNumber: number;
	/** @public */
	headSha: string;
	/** @public */
	feedbackCursor: number;
	/** @public */
	lastConflictKey?: string | null;
	/** @public */
	pollInterval?: string;
	/** @internal */
	disabled?: boolean;
	/** @public */
	eventKinds?: Array<"checks" | "feedback" | "merged" | "closed" | "merge_conflict">;
	/** @internal */
	checkStatuses?: Array<"pending" | "success" | "failure">;
}

/** @internal */
export const GITHUB_RELEASE_KIND = "@leitwerk-private/github.release";

/** @internal */
export interface GitHubReleaseSourceConfig {
	/** @internal */
	profile: string;
	/** @internal */
	owner: string;
	/** @internal */
	repo: string;
	/** @internal */
	mergeSha: string;
	/** @internal */
	pollInterval?: string;
	/** @internal */
	disabled?: boolean;
}

/** @internal */
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

/** @public */
export const GITHUB_PR_TERMINAL_KIND = "@leitwerk-public/github.pr_terminal";
/** @public */
export const GITHUB_PR_FEEDBACK_KIND = "@leitwerk-public/github.pr_feedback";
/** @public */
export const GITHUB_ISSUE_CANCELLED_KIND = "@leitwerk-public/github.issue_cancelled";

/** @public */
export interface GitHubPullRequestTerminalSourceConfig {
	/** @public */
	profile: string;
	/** @public */
	owner: string;
	/** @public */
	repo: string;
	/** @public */
	prNumber: number;
	/** @public */
	pollInterval?: string;
	/** @public */
	terminalOutcome?: "merged" | "closed";
	/** @internal */
	disabled?: boolean;
}

/** @public */
export interface GitHubFeedbackSourceConfig extends GitHubPullRequestTerminalSourceConfig {
	/** @public */
	conversationCursor: number;
	/** @public */
	reviewCursor: number;
	/** @public */
	inlineCursor: number;
	/** @public */
	quietPeriodMs: number;
}

/** @public */
export interface GitHubIssueCancelledSourceConfig {
	/** @public */
	profile: string;
	/** @public */
	owner: string;
	/** @public */
	repo: string;
	/** @public */
	issueNumber: number;
	/** @public */
	triggerLabel: string;
	/** @public */
	pollInterval?: string;
}

/** @public */
export const GITHUB_CHECKS_KIND = "@leitwerk-public/github.checks";

/** @public */
export const githubExternal = {
	/** @public */
	checks: defineExternalActionSource<{
		afterKey?: string;
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
	/** @public */
	issueCancelled: defineExternalActionSource<GitHubIssueCancelledSourceConfig>({
		kind: GITHUB_ISSUE_CANCELLED_KIND,
		describeEvent: () => ({ summary: "Source issue cancelled" }),
		label: "GitHub source issue cancelled",
		description: "Fires when the source issue closes or loses its trigger label",
	}),
	/** @public */
	pullRequestTerminal: defineExternalActionSource<GitHubPullRequestTerminalSourceConfig>({
		kind: GITHUB_PR_TERMINAL_KIND,
		describeEvent: describeGitHubEvent,
		label: "GitHub pull request merged or closed",
		description: "Fires when the tracked pull request reaches a terminal state",
	}),
	/** @public */
	pullRequestFeedback: defineExternalActionSource<GitHubFeedbackSourceConfig>({
		kind: GITHUB_PR_FEEDBACK_KIND,
		describeEvent: () => ({ summary: "Pull request feedback received" }),
		label: "GitHub pull request feedback",
		description: "Fires after unseen human feedback has been quiet long enough to batch",
	}),
	/** @internal */
	releaseContaining: defineExternalActionSource<GitHubReleaseSourceConfig>({
		kind: GITHUB_RELEASE_KIND,
		label: "Published GitHub release",
		description: "Fires when a published release contains the tracked merge commit",
	}),
	/** @public */
	pullRequestState: defineExternalActionSource<GitHubPullRequestSourceConfig>({
		kind: GITHUB_PR_STATE_KIND,
		describeEvent: describeGitHubEvent,
		label: "GitHub pull request state",
		description: "Fires for failed or successful checks, review feedback, and terminal PR state",
	}),
};
