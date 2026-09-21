import { asUnknownRecord } from "@leitwerk-dev/domain";
import type { RepositoryFeedbackBatchConfig } from "./repository-feedback.js";

/** Parse common forge source fields, preserving polling defaults and permissive string handling. @public */
export function parseRepositoryPullRequestConfig(
	value: unknown,
): RepositoryPullRequestSourceConfig | null {
	const config = asUnknownRecord(value) ?? {};
	if (
		typeof config.profile !== "string" ||
		typeof config.owner !== "string" ||
		typeof config.repo !== "string" ||
		typeof config.prNumber !== "number"
	)
		return null;
	const terminalOutcome: "merged" | "closed" | undefined =
		config.terminalOutcome === "merged" || config.terminalOutcome === "closed"
			? config.terminalOutcome
			: undefined;
	return {
		/** @public */
		profile: config.profile,
		/** @public */
		owner: config.owner,
		/** @public */
		repo: config.repo,
		/** @public */
		prNumber: config.prNumber,
		/** @public */
		pollInterval: typeof config.pollInterval === "string" ? config.pollInterval : "30s",
		/** @public */
		terminalOutcome,
		/** @public */
		disabled: config.disabled === true,
	};
}

/** @public */
export function parseRepositoryFeedbackConfig(
	value: unknown,
): RepositoryFeedbackSourceConfig | null {
	const base = parseRepositoryPullRequestConfig(value);
	const config = asUnknownRecord(value) ?? {};
	if (!base) return null;
	return {
		...base,
		/** @public */
		conversationCursor:
			typeof config.conversationCursor === "number" ? config.conversationCursor : 0,
		/** @public */
		reviewCursor: typeof config.reviewCursor === "number" ? config.reviewCursor : 0,
		/** @public */
		inlineCursor: typeof config.inlineCursor === "number" ? config.inlineCursor : 0,
		/** @public */
		quietPeriodMs: typeof config.quietPeriodMs === "number" ? config.quietPeriodMs : 120_000,
	};
}

/** @public */
export function parseRepositoryIssueCancelledConfig(
	value: unknown,
): RepositoryIssueCancelledSourceConfig | null {
	const config = asUnknownRecord(value) ?? {};
	if (
		typeof config.profile !== "string" ||
		typeof config.owner !== "string" ||
		typeof config.repo !== "string" ||
		typeof config.issueNumber !== "number" ||
		typeof config.triggerLabel !== "string"
	)
		return null;
	return {
		/** @public */
		profile: config.profile,
		/** @public */
		owner: config.owner,
		/** @public */
		repo: config.repo,
		/** @public */
		issueNumber: config.issueNumber,
		/** @public */
		triggerLabel: config.triggerLabel,
		/** @public */
		pollInterval: typeof config.pollInterval === "string" ? config.pollInterval : "30s",
	};
}
/** @public */
export interface RepositoryPullRequestSourceConfig {
	/** @public */
	profile: string;
	/** @public */
	owner: string;
	/** @public */
	repo: string;
	/** @public */
	prNumber: number;
	/** @public */
	pollInterval: string;
	/** @public */
	terminalOutcome: "merged" | "closed" | undefined;
	/** @public */
	disabled: boolean;
}
/** @public */
export interface RepositoryFeedbackSourceConfig
	extends RepositoryPullRequestSourceConfig,
		RepositoryFeedbackBatchConfig {}
/** @public */
export interface RepositoryIssueCancelledSourceConfig {
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
	pollInterval: string;
}
