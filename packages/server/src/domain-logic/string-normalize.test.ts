import { describe, expect, it } from "vitest";
import { normalizeStringArray, trimString } from "./string-normalize.js";

describe("trimString", () => {
	it("trims strings and returns empty for non-strings", () => {
		expect(trimString("  hello  ")).toBe("hello");
		expect(trimString("   ")).toBe("");
		expect(trimString(42)).toBe("");
		expect(trimString(null)).toBe("");
	});
});

describe("normalizeStringArray", () => {
	it("returns an empty array for non-arrays", () => {
		expect(normalizeStringArray("not-an-array")).toEqual([]);
		expect(normalizeStringArray(undefined)).toEqual([]);
	});

	it("trims entries and drops empty or non-string values", () => {
		expect(normalizeStringArray(["  alpha  ", " ", 42, "beta", null])).toEqual(["alpha", "beta"]);
	});
});
