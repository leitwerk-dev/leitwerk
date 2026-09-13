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
		{},
		{ value: 1 },
		new Date(0),
		Object.create(null),
	])("accepts non-array objects without cloning or validating their fields", (value) => {
		expect(isUnknownRecord(value)).toBe(true);
		expect(asUnknownRecord(value)).toBe(value);
		expect(v.parse(copiedUnknownRecordSchema, value)).not.toBe(value);
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
