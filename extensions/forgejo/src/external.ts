import { defineExternalActionSource } from "@leitwerk-dev/process-sdk";
import { describeConflict } from "@leitwerk-dev/repository-rebase";

/** @internal */
export const FORGEJO_PR_CONFLICT_KIND = "@leitwerk-private/forgejo.pr_conflict";

/** @internal */
export interface ForgejoConflictSourceConfig extends ForgejoPullRequestSourceConfig {
	/** @internal */
	headSha: string;
	/** @internal */
	lastConflictKey?: string | null;
}

/** @internal */
export const FORGEJO_PR_TERMINAL_KIND = "@leitwerk-private/forgejo.pr_terminal";
/** @internal */
export const FORGEJO_PR_FEEDBACK_KIND = "@leitwerk-private/forgejo.pr_feedback";
/** @internal */
export const FORGEJO_ISSUE_CANCELLED_KIND = "@leitwerk-private/forgejo.issue_cancelled";

/** @internal */
export interface ForgejoPullRequestSourceConfig {
	/** @internal */
	profile: string;
	/** @internal */
	owner: string;
	/** @internal */
	repo: string;
	/** @internal */
	prNumber: number;
	/** @internal */
	pollInterval?: string;
	/** @internal */
	terminalOutcome?: "merged" | "closed";
	/** @internal */
	disabled?: boolean;
}

/** @internal */
export interface ForgejoFeedbackSourceConfig extends ForgejoPullRequestSourceConfig {
	/** @internal */
	conversationCursor: number;
	/** @internal */
	reviewCursor: number;
	/** @internal */
	inlineCursor: number;
	/** @internal */
	quietPeriodMs: number;
}

/** @internal */
export interface ForgejoIssueCancelledSourceConfig {
	/** @internal */
	profile: string;
	/** @internal */
	owner: string;
	/** @internal */
	repo: string;
	/** @internal */
	issueNumber: number;
	/** @internal */
	triggerLabel: string;
	/** @internal */
	pollInterval?: string;
}

/** @internal */
export const forgejoExternal = {
	/** @internal */
	pullRequestConflict: defineExternalActionSource<ForgejoConflictSourceConfig>({
		kind: FORGEJO_PR_CONFLICT_KIND,
		label: "Forgejo pull request conflict",
		description: "Fires for a confirmed conflict on the tracked head and current base",
		describeEvent: describeConflict,
	}),
	/** @internal */
	issueCancelled: defineExternalActionSource<ForgejoIssueCancelledSourceConfig>({
		kind: FORGEJO_ISSUE_CANCELLED_KIND,
		label: "Forgejo source issue cancelled",
		description: "Fires when the source issue closes or loses its trigger label",
	}),
	/** @internal */
	pullRequestTerminal: defineExternalActionSource<ForgejoPullRequestSourceConfig>({
		kind: FORGEJO_PR_TERMINAL_KIND,
		label: "Forgejo pull request merged or closed",
		description: "Fires when the tracked pull request reaches a terminal state",
	}),
	/** @internal */
	pullRequestFeedback: defineExternalActionSource<ForgejoFeedbackSourceConfig>({
		kind: FORGEJO_PR_FEEDBACK_KIND,
		label: "Forgejo pull request feedback",
		description: "Fires after unseen human feedback has been quiet long enough to batch",
	}),
};
