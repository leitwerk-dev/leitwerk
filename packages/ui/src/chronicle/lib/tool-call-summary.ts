import * as v from "valibot";
import { truncateText } from "../../lib/markdown";

const unknownRecordSchema = v.pipe(
	v.unknown(),
	v.check(
		(value) => typeof value === "object" && value !== null && !Array.isArray(value),
		"Expected object",
	),
	v.record(v.string(), v.unknown()),
);

function isScalar(value: unknown): value is string | number | boolean {
	return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function formatScalar(value: string | number | boolean): string {
	return typeof value === "string" ? truncateText(value, 80) : String(value);
}

export function summarizeToolPayload(value: unknown, maxFields = 2): string | null {
	if (value === null || value === undefined) {
		return null;
	}
	if (isScalar(value)) {
		return formatScalar(value);
	}
	if (Array.isArray(value)) {
		if (value.length === 0) {
			return "Empty list";
		}
		const scalarItems = value.filter(isScalar).slice(0, maxFields).map(formatScalar);
		return scalarItems.length > 0
			? `${scalarItems.join(", ")} · ${value.length} item${value.length === 1 ? "" : "s"}`
			: `List with ${value.length} item${value.length === 1 ? "" : "s"}`;
	}
	const parsedRecord = v.safeParse(unknownRecordSchema, value);
	if (parsedRecord.success) {
		const scalarEntries = Object.entries(parsedRecord.output)
			.filter(([, entryValue]) => isScalar(entryValue))
			.slice(0, maxFields)
			.map(([key, entryValue]) => `${key}: ${formatScalar(entryValue)}`);
		if (scalarEntries.length > 0) {
			return scalarEntries.join(" · ");
		}
		const keys = Object.keys(parsedRecord.output);
		return `${keys.length} field${keys.length === 1 ? "" : "s"} captured`;
	}
	return truncateText(String(value), 80);
}

export function formatStructuredValue(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}
	if (value === null || value === undefined) {
		return "";
	}
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}
