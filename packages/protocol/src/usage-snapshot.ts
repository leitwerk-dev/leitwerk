import * as v from "valibot";

export interface UsageCostSnapshot {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

export interface UsageSnapshot {
	input: number;
	output: number;
	/** Provider-reported reasoning/thinking tokens. This is a subset of output tokens. */
	reasoning?: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: UsageCostSnapshot | null;
	/** Number of model requests represented by this aggregate, when known. */
	requestCount?: number;
	/** Largest input-token count for a single represented model request, when known. */
	maxInputTokens?: number;
}

const unknownRecordSchema = v.pipe(
	v.unknown(),
	v.check(
		(value) => typeof value === "object" && value !== null && !Array.isArray(value),
		"Expected object",
	),
	v.record(v.string(), v.unknown()),
);

function readNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeUsageCostSnapshot(value: unknown): UsageCostSnapshot | null {
	const parsedValue = v.safeParse(unknownRecordSchema, value);
	if (!parsedValue.success) {
		return null;
	}
	const record = parsedValue.output;
	const input = readNumber(record.input);
	const output = readNumber(record.output);
	const cacheRead = readNumber(record.cacheRead);
	const cacheWrite = readNumber(record.cacheWrite);
	const total =
		typeof record.total === "number" && Number.isFinite(record.total)
			? record.total
			: input + output + cacheRead + cacheWrite;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		total,
	};
}

function cloneUsageCostSnapshot(cost: UsageCostSnapshot): UsageCostSnapshot {
	return { ...cost };
}

export function cloneUsageSnapshot(usage: UsageSnapshot | null | undefined): UsageSnapshot | null {
	if (!usage) {
		return null;
	}
	return {
		...usage,
		cost: usage.cost ? cloneUsageCostSnapshot(usage.cost) : null,
	};
}

export function normalizeUsageSnapshot(value: unknown): UsageSnapshot | null {
	const parsedValue = v.safeParse(unknownRecordSchema, value);
	if (!parsedValue.success) {
		return null;
	}
	const record = parsedValue.output;
	const input = readNumber(record.input);
	const output = readNumber(record.output);
	const reasoning =
		typeof record.reasoning === "number" && Number.isFinite(record.reasoning)
			? record.reasoning
			: undefined;
	const cacheRead = readNumber(record.cacheRead);
	const cacheWrite = readNumber(record.cacheWrite);
	const totalTokens =
		typeof record.totalTokens === "number" && Number.isFinite(record.totalTokens)
			? record.totalTokens
			: input + output + cacheRead + cacheWrite;
	const cost = normalizeUsageCostSnapshot(record.cost);
	const requestCount =
		typeof record.requestCount === "number" && Number.isFinite(record.requestCount)
			? Math.max(0, Math.floor(record.requestCount))
			: 1;
	const maxInputTokens =
		typeof record.maxInputTokens === "number" && Number.isFinite(record.maxInputTokens)
			? Math.max(0, record.maxInputTokens)
			: input;
	const hasExplicitUsageTelemetry =
		["input", "output", "reasoning", "cacheRead", "cacheWrite", "totalTokens"].some(
			(key) => typeof record[key] === "number" && Number.isFinite(record[key]),
		) || cost !== null;
	if (
		!hasExplicitUsageTelemetry &&
		input === 0 &&
		output === 0 &&
		cacheRead === 0 &&
		cacheWrite === 0 &&
		totalTokens === 0
	) {
		return null;
	}
	return {
		input,
		output,
		...(reasoning !== undefined ? { reasoning } : {}),
		cacheRead,
		cacheWrite,
		totalTokens,
		cost,
		requestCount,
		maxInputTokens,
	};
}

export function mergeUsageSnapshots(
	total: UsageSnapshot | null,
	usage: UsageSnapshot | null,
): UsageSnapshot | null {
	if (!usage) {
		return total ? cloneUsageSnapshot(total) : null;
	}
	if (!total) {
		return cloneUsageSnapshot(usage);
	}
	const hasRequestMetrics =
		total.requestCount !== undefined ||
		usage.requestCount !== undefined ||
		total.maxInputTokens !== undefined ||
		usage.maxInputTokens !== undefined;
	return {
		input: total.input + usage.input,
		output: total.output + usage.output,
		...(total.reasoning !== undefined || usage.reasoning !== undefined
			? { reasoning: (total.reasoning ?? 0) + (usage.reasoning ?? 0) }
			: {}),
		cacheRead: total.cacheRead + usage.cacheRead,
		cacheWrite: total.cacheWrite + usage.cacheWrite,
		totalTokens: total.totalTokens + usage.totalTokens,
		cost:
			total.cost && usage.cost
				? {
						input: total.cost.input + usage.cost.input,
						output: total.cost.output + usage.cost.output,
						cacheRead: total.cost.cacheRead + usage.cost.cacheRead,
						cacheWrite: total.cost.cacheWrite + usage.cost.cacheWrite,
						total: total.cost.total + usage.cost.total,
					}
				: null,
		...(hasRequestMetrics
			? {
					requestCount: (total.requestCount ?? 1) + (usage.requestCount ?? 1),
					maxInputTokens: Math.max(
						total.maxInputTokens ?? total.input,
						usage.maxInputTokens ?? usage.input,
					),
				}
			: {}),
	};
}
