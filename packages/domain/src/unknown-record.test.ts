import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { asUnknownRecord, copiedUnknownRecordSchema, isUnknownRecord } from "./unknown-record.js";

describe("unknown records", () => {
	it.each([null, undefined, [], "text", 1, true, () => {}])("rejects %j", (value) => {
		expect(isUnknownRecord(value)).toBe(false);
		expect(asUnknownRecord(value)).toBeNull();
		expect(v.safeParse(copiedUnknownRecordSchema, value).success).toBe(false);
	});

	it.each([
		{ value: {}, expected: {} },
		{ value: { value: 1 }, expected: { value: 1 } },
		{ value: new Date(0), expected: {} },
		{ value: Object.create(null), expected: {} },
	])("accepts $value and copies its own safe fields", ({ value, expected }) => {
		expect(isUnknownRecord(value)).toBe(true);
		expect(asUnknownRecord(value)).toBe(value);
		const copied = v.parse(copiedUnknownRecordSchema, value);
		expect(copied).toEqual(expected);
		expect(copied).not.toBe(value);
	});

	it("copies own safe keys without changing nested values", () => {
		const value = Object.assign(Object.create({ inherited: true }), {
			constructor: "ignored",
			prototype: "ignored",
			nested: {},
		});
		const parsed = v.parse(copiedUnknownRecordSchema, value);
		expect(parsed).toEqual({ nested: {} });
		expect(parsed.nested).toBe(value.nested);
	});
});
