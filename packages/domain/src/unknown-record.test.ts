import { describe, expect, it } from "vitest";
import { asUnknownRecord, isUnknownRecord } from "./unknown-record.js";

describe("unknown records", () => {
	it.each([null, undefined, [], "text", 1, true, () => {}])("rejects %j", (value) => {
		expect(isUnknownRecord(value)).toBe(false);
		expect(asUnknownRecord(value)).toBeNull();
	});

	it.each([
		{},
		{ value: 1 },
		new Date(0),
		Object.create(null),
	])("accepts non-array objects without cloning or validating their fields", (value) => {
		expect(isUnknownRecord(value)).toBe(true);
		expect(asUnknownRecord(value)).toBe(value);
	});
});
