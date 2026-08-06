import type { TurnUsageSnapshot } from "@leitwerk-dev/protocol";
import { describe, expect, it } from "vitest";
import { formatUsageSummaryTitle, formatUsdEstimate } from "./cost-estimates.js";

function usage(overrides: Partial<TurnUsageSnapshot> = {}): TurnUsageSnapshot {
	return {
		input: overrides.input ?? 120,
		output: overrides.output ?? 24,
		...(overrides.reasoning !== undefined ? { reasoning: overrides.reasoning } : {}),
		cacheRead: overrides.cacheRead ?? 0,
		cacheWrite: overrides.cacheWrite ?? 0,
		totalTokens: overrides.totalTokens ?? 144,
		cost:
			overrides.cost ??
			({
				input: 0.5,
				output: 0.25,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0.75,
			} satisfies NonNullable<TurnUsageSnapshot["cost"]>),
		...(overrides.requestCount !== undefined ? { requestCount: overrides.requestCount } : {}),
		...(overrides.maxInputTokens !== undefined ? { maxInputTokens: overrides.maxInputTokens } : {}),
	};
}

describe("cost estimate formatting", () => {
	it("describes aggregate request context and estimated cost", () => {
		const exampleUsage = usage({ reasoning: 18, requestCount: 2, maxInputTokens: 90 });
		const title = formatUsageSummaryTitle(exampleUsage);

		expect(title).toContain("Aggregate across model calls");
		expect(title).toContain("Estimated total:");
		expect(title).toContain("Input: 120");
		expect(title).toContain("Reported reasoning: 18");
		expect(title).toContain("Requests: 2");
		expect(title).toContain("Max single-request input: 90");
		expect(title).toContain("hidden prior branch entries");
		expect(title).toContain(formatUsdEstimate(exampleUsage.cost?.total ?? 0));
		expect(formatUsdEstimate(0.75)).not.toEqual(formatUsdEstimate(0.5));
	});
});
