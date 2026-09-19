import * as v from "valibot";

/** Parse non-array objects into a fresh record using Valibot's key handling. @internal */
export const copiedUnknownRecordSchema = v.pipe(
	v.unknown(),
	v.check(isUnknownRecord, "Expected object"),
	v.record(v.string(), v.unknown()),
);

/** @internal */
export function isUnknownRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @internal */
export function asUnknownRecord(value: unknown): Record<string, unknown> | null {
	return isUnknownRecord(value) ? value : null;
}
