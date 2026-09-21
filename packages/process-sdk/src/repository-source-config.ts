import { asUnknownRecord } from "@leitwerk-dev/domain";

/** Parse common forge source fields, preserving polling defaults and permissive string handling. @internal */
export function parseRepositoryPullRequestConfig(value: unknown) {
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
		/** @internal */
		profile: config.profile,
		/** @internal */
		owner: config.owner,
		/** @internal */
		repo: config.repo,
		/** @internal */
		prNumber: config.prNumber,
		/** @internal */
		pollInterval: typeof config.pollInterval === "string" ? config.pollInterval : "30s",
		/** @internal */
		terminalOutcome,
		/** @internal */
		disabled: config.disabled === true,
	};
}

/** @internal */
export function parseRepositoryFeedbackConfig(value: unknown) {
	const base = parseRepositoryPullRequestConfig(value);
	const config = asUnknownRecord(value) ?? {};
	if (!base) return null;
	return {
		...base,
		/** @internal */
		conversationCursor:
			typeof config.conversationCursor === "number" ? config.conversationCursor : 0,
		/** @internal */
		reviewCursor: typeof config.reviewCursor === "number" ? config.reviewCursor : 0,
		/** @internal */
		inlineCursor: typeof config.inlineCursor === "number" ? config.inlineCursor : 0,
		/** @internal */
		quietPeriodMs: typeof config.quietPeriodMs === "number" ? config.quietPeriodMs : 120_000,
	};
}

/** @internal */
export function parseRepositoryIssueCancelledConfig(value: unknown) {
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
		/** @internal */
		profile: config.profile,
		/** @internal */
		owner: config.owner,
		/** @internal */
		repo: config.repo,
		/** @internal */
		issueNumber: config.issueNumber,
		/** @internal */
		triggerLabel: config.triggerLabel,
		/** @internal */
		pollInterval: typeof config.pollInterval === "string" ? config.pollInterval : "30s",
	};
}
