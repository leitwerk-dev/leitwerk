import { defineExternalActionSource } from "@leitwerk-dev/process-sdk";
import { describeConflict } from "@leitwerk-dev/repository-rebase";

export const FORGEJO_PR_CONFLICT_KIND = "@leitwerk-private/forgejo.pr_conflict";

export interface ForgejoConflictSourceConfig extends ForgejoPullRequestSourceConfig {
	headSha: string;
	lastConflictKey?: string | null;
}

export const FORGEJO_PR_TERMINAL_KIND = "@leitwerk-private/forgejo.pr_terminal";
export const FORGEJO_PR_FEEDBACK_KIND = "@leitwerk-private/forgejo.pr_feedback";
export const FORGEJO_ISSUE_CANCELLED_KIND = "@leitwerk-private/forgejo.issue_cancelled";

export interface ForgejoPullRequestSourceConfig {
	profile: string;
	owner: string;
	repo: string;
	prNumber: number;
	pollInterval?: string;
	terminalOutcome?: "merged" | "closed";
	disabled?: boolean;
}

export interface ForgejoFeedbackSourceConfig extends ForgejoPullRequestSourceConfig {
	conversationCursor: number;
	reviewCursor: number;
	inlineCursor: number;
	quietPeriodMs: number;
}

export interface ForgejoIssueCancelledSourceConfig {
	profile: string;
	owner: string;
	repo: string;
	issueNumber: number;
	triggerLabel: string;
	pollInterval?: string;
}

export const forgejoExternal = {
	pullRequestConflict: defineExternalActionSource<ForgejoConflictSourceConfig>({
		kind: FORGEJO_PR_CONFLICT_KIND,
		label: "Forgejo pull request conflict",
		description: "Fires for a confirmed conflict on the tracked head and current base",
		describeEvent: describeConflict,
	}),
	issueCancelled: defineExternalActionSource<ForgejoIssueCancelledSourceConfig>({
		kind: FORGEJO_ISSUE_CANCELLED_KIND,
		label: "Forgejo source issue cancelled",
		description: "Fires when the source issue closes or loses its trigger label",
	}),
	pullRequestTerminal: defineExternalActionSource<ForgejoPullRequestSourceConfig>({
		kind: FORGEJO_PR_TERMINAL_KIND,
		label: "Forgejo pull request merged or closed",
		description: "Fires when the tracked pull request reaches a terminal state",
	}),
	pullRequestFeedback: defineExternalActionSource<ForgejoFeedbackSourceConfig>({
		kind: FORGEJO_PR_FEEDBACK_KIND,
		label: "Forgejo pull request feedback",
		description: "Fires after unseen human feedback has been quiet long enough to batch",
	}),
};
