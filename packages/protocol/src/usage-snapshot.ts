import { copiedUnknownRecordSchema as unknownRecordSchema } from "@leitwerk-dev/domain";
import * as v from "valibot";

/** @internal */
export interface UsageCostSnapshot {
	/** @internal */
	input: number;
	/** @internal */
	output: number;
	/** @internal */
	cacheRead: number;
	/** @internal */
	cacheWrite: number;
	/** @internal */
	total: number;
}

/** @internal */
export interface UsageTokenCounts {
	/** @internal */
	input: number;
	/** @internal */
	output: number;
	/** Provider-reported reasoning/thinking tokens. This is a subset of output tokens. */
	/** @internal */
	reasoning?: number;
	/** @internal */
	cacheRead: number;
	/** @internal */
	cacheWrite: number;
	/** @internal */
	totalTokens: number;
}

/** @internal */
export interface UsageSnapshot extends UsageTokenCounts {
	/** @internal */
	cost: UsageCostSnapshot | null;
	/** Number of model requests represented by this aggregate, when known. */
	/** @internal */
	requestCount?: number;
	/** Largest input-token count for a single represented model request, when known. */
	/** @internal */
	maxInputTokens?: number;
}

function readFiniteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeUsageCostSnapshot(value: unknown): UsageCostSnapshot | null {
	const parsedValue = v.safeParse(unknownRecordSchema, value);
	if (!parsedValue.success) {
		return null;
	}
	const record = parsedValue.output;
	const input = readFiniteNumber(record.input) ?? 0;
	const output = readFiniteNumber(record.output) ?? 0;
	const cacheRead = readFiniteNumber(record.cacheRead) ?? 0;
	const cacheWrite = readFiniteNumber(record.cacheWrite) ?? 0;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		total: readFiniteNumber(record.total) ?? input + output + cacheRead + cacheWrite,
	};
}

/** @internal */
export function cloneUsageSnapshot(usage: UsageSnapshot | null | undefined): UsageSnapshot | null {
	if (!usage) {
		return null;
	}
	return {
		...usage,
		cost: usage.cost ? { ...usage.cost } : null,
	};
}

/** @internal */
export function normalizeUsageSnapshot(value: unknown): UsageSnapshot | null {
	const parsedValue = v.safeParse(unknownRecordSchema, value);
	if (!parsedValue.success) {
		return null;
	}
	const record = parsedValue.output;
	const input = readFiniteNumber(record.input) ?? 0;
	const output = readFiniteNumber(record.output) ?? 0;
	const reasoning = readFiniteNumber(record.reasoning);
	const cacheRead = readFiniteNumber(record.cacheRead) ?? 0;
	const cacheWrite = readFiniteNumber(record.cacheWrite) ?? 0;
	const cost = normalizeUsageCostSnapshot(record.cost);
	const maxInputTokens = readFiniteNumber(record.maxInputTokens);
	const hasExplicitUsageTelemetry =
		["input", "output", "reasoning", "cacheRead", "cacheWrite", "totalTokens"].some(
			(key) => readFiniteNumber(record[key]) !== undefined,
		) || cost !== null;
	if (!hasExplicitUsageTelemetry) {
		return null;
	}
	return {
		input,
		output,
		...(reasoning !== undefined ? { reasoning } : {}),
		cacheRead,
		cacheWrite,
		totalTokens: readFiniteNumber(record.totalTokens) ?? input + output + cacheRead + cacheWrite,
		cost,
		requestCount: Math.max(0, Math.floor(readFiniteNumber(record.requestCount) ?? 1)),
		maxInputTokens: maxInputTokens !== undefined ? Math.max(0, maxInputTokens) : input,
	};
}

/** @internal */
export function mergeUsageSnapshots(
	total: UsageSnapshot | null,
	usage: UsageSnapshot | null,
): UsageSnapshot | null {
	if (!usage) {
		return cloneUsageSnapshot(total);
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
