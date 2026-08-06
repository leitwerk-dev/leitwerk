import { describe, expect, it } from "vitest";
import { parseDurationMs } from "./duration-parse.js";

describe("parseDurationMs", () => {
	it("parses common duration formats", () => {
		expect(parseDurationMs("150ms", 60_000)).toBe(150);
		expect(parseDurationMs("2s", 60_000)).toBe(2_000);
		expect(parseDurationMs("1.5s", 60_000)).toBe(1_500);
		expect(parseDurationMs("2 min", 60_000)).toBe(120_000);
		expect(parseDurationMs("1h", 60_000)).toBe(3_600_000);
	});

	it("returns the default for invalid or negative durations", () => {
		expect(parseDurationMs("garbage", 60_000)).toBe(60_000);
		expect(parseDurationMs("-1s", 60_000)).toBe(60_000);
	});

	it("retains the allowHours option for existing callers", () => {
		expect(parseDurationMs("1h", 30_000, { allowHours: true })).toBe(3_600_000);
	});
});
