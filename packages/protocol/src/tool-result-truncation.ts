function asUnknownRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

const TOOL_TRUNCATION_BOOLEAN_KEYS = [
	"truncated",
	"isTruncated",
	"wasTruncated",
	"outputTruncated",
	"resultTruncated",
] as const;
const TOOL_TRUNCATION_TEXT_MARKERS = [
	"output truncated",
	"result truncated",
	"response was too big",
	"too large to display",
	"truncated after",
	"truncated to last",
	"truncated since",
] as const;

function readTruncationPayload(value: unknown): unknown {
	const record = asUnknownRecord(value);
	if (!record) {
		return null;
	}
	if ("truncation" in record) {
		return record.truncation;
	}
	for (const key of TOOL_TRUNCATION_BOOLEAN_KEYS) {
		if (key in record) {
			return record[key];
		}
	}
	return null;
}

function isExplicitFalseTruncationString(value: string): boolean {
	const normalized = value.trim().toLowerCase();
	return (
		normalized === "" ||
		normalized === "false" ||
		normalized === "none" ||
		normalized === "null" ||
		normalized === "no" ||
		normalized === "0"
	);
}

function isTruthyTruncationValue(value: unknown): boolean {
	if (value === null || value === undefined) {
		return false;
	}
	if (typeof value === "boolean") {
		return value;
	}
	if (typeof value === "number") {
		return Number.isFinite(value) && value > 0;
	}
	if (typeof value === "string") {
		return !isExplicitFalseTruncationString(value);
	}
	if (Array.isArray(value)) {
		return value.length > 0;
	}
	const record = asUnknownRecord(value);
	if (!record) {
		return true;
	}
	for (const key of TOOL_TRUNCATION_BOOLEAN_KEYS) {
		if (record[key] === true) {
			return true;
		}
	}
	return Object.keys(record).some((key) => {
		if (
			TOOL_TRUNCATION_BOOLEAN_KEYS.includes(key as (typeof TOOL_TRUNCATION_BOOLEAN_KEYS)[number])
		) {
			return false;
		}
		return isTruthyTruncationValue(record[key]);
	});
}

export function isToolResultTruncated(input: {
	resultText: string | null;
	resultDetails: unknown;
	resultValue: unknown;
}): boolean {
	const normalizedText = input.resultText?.toLowerCase() ?? "";
	return (
		TOOL_TRUNCATION_TEXT_MARKERS.some((marker) => normalizedText.includes(marker)) ||
		isTruthyTruncationValue(readTruncationPayload(input.resultDetails)) ||
		isTruthyTruncationValue(readTruncationPayload(input.resultValue))
	);
}
