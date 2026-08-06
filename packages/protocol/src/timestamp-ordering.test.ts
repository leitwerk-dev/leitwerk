import { describe, expect, it } from "vitest";
import { compareTimestampStrings, happenedOnOrAfterStart } from "./timestamp-ordering.js";

describe("timestamp ordering helpers", () => {
	it("orders parseable timestamps chronologically", () => {
		expect(
			compareTimestampStrings("2026-04-26T10:00:00.000Z", "2026-04-26T10:00:01.000Z"),
		).toBeLessThan(0);
		expect(
			compareTimestampStrings("2026-04-26T10:00:01.000Z", "2026-04-26T10:00:00.000Z"),
		).toBeGreaterThan(0);
	});

	it("treats different timestamp spellings for the same instant as equal", () => {
		expect(compareTimestampStrings("2026-04-26T10:00:05Z", "2026-04-26T10:00:05.000Z")).toBe(0);
		expect(happenedOnOrAfterStart("2026-04-26T10:00:05Z", "2026-04-26T10:00:05.000Z")).toBe(true);
	});

	it("falls back to lexical ordering when either timestamp cannot be parsed", () => {
		expect(compareTimestampStrings("not-a-date-a", "not-a-date-b")).toBeLessThan(0);
		expect(compareTimestampStrings("not-a-date-b", "not-a-date-a")).toBeGreaterThan(0);
		expect(compareTimestampStrings("2026-04-26T10:00:00.000Z", "not-a-date")).toBeLessThan(0);
	});

	it("accepts all entries when no start timestamp is available", () => {
		expect(happenedOnOrAfterStart("not-a-date", null)).toBe(true);
	});
});
