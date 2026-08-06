import type { TurnUsageSnapshot } from "@leitwerk-dev/protocol";

const usdEstimateFormatter = new Intl.NumberFormat(undefined, {
	style: "currency",
	currency: "USD",
	minimumFractionDigits: 4,
	maximumFractionDigits: 4,
});

export function formatUsdEstimate(value: number): string {
	return usdEstimateFormatter.format(value);
}

export function formatUsageSummaryTitle(usage: TurnUsageSnapshot): string {
	const parts = [
		"Aggregate across model calls for this turn.",
		`Input: ${usage.input}`,
		`Output: ${usage.output}`,
		...(usage.reasoning !== undefined ? [`Reported reasoning: ${usage.reasoning}`] : []),
		`Cache Read: ${usage.cacheRead}`,
		`Cache Write: ${usage.cacheWrite}`,
		`Total tokens: ${usage.totalTokens}`,
		...(usage.requestCount !== undefined ? [`Requests: ${usage.requestCount}`] : []),
		...(usage.maxInputTokens !== undefined
			? [`Max single-request input: ${usage.maxInputTokens}`]
			: []),
		"Context source: Pi request context includes the active branch, including hidden prior branch entries and tool results that may not be rendered in the summary.",
	];
	if (usage.cost) {
		parts.push(
			[
				`Estimated total: ${formatUsdEstimate(usage.cost.total)}`,
				`input ${formatUsdEstimate(usage.cost.input)}`,
				`output ${formatUsdEstimate(usage.cost.output)}`,
				`cache read ${formatUsdEstimate(usage.cost.cacheRead)}`,
				`cache write ${formatUsdEstimate(usage.cost.cacheWrite)}`,
			].join(", "),
		);
	}
	return parts.join(", ");
}
