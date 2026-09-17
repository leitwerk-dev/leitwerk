import { asUnknownRecord } from "@leitwerk-dev/domain";

/** Parse common forge source fields, preserving polling defaults and permissive string handling. */
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
		profile: config.profile,
		owner: config.owner,
		repo: config.repo,
		prNumber: config.prNumber,
		pollInterval: typeof config.pollInterval === "string" ? config.pollInterval : "30s",
		terminalOutcome,
		disabled: config.disabled === true,
	};
}

export function parseRepositoryFeedbackConfig(value: unknown) {
	const base = parseRepositoryPullRequestConfig(value);
	const config = asUnknownRecord(value) ?? {};
	if (!base) return null;
	return {
		...base,
		conversationCursor:
			typeof config.conversationCursor === "number" ? config.conversationCursor : 0,
		reviewCursor: typeof config.reviewCursor === "number" ? config.reviewCursor : 0,
		inlineCursor: typeof config.inlineCursor === "number" ? config.inlineCursor : 0,
		quietPeriodMs: typeof config.quietPeriodMs === "number" ? config.quietPeriodMs : 120_000,
	};
}

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
		profile: config.profile,
		owner: config.owner,
		repo: config.repo,
		issueNumber: config.issueNumber,
		triggerLabel: config.triggerLabel,
		pollInterval: typeof config.pollInterval === "string" ? config.pollInterval : "30s",
	};
}
