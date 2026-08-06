import { describe, expect, it } from "vitest";
import {
	formatCompactTokenCount,
	normalizeChronicleLineEndings,
	normalizeChronicleText,
	splitChronicleLines,
} from "./formatting.js";

describe("chronicle formatting helpers", () => {
	it("normalizes mixed line endings", () => {
		expect(normalizeChronicleLineEndings("a\r\nb\rc")).toBe("a\nb\nc");
	});

	it("trims normalized chronicle text", () => {
		expect(normalizeChronicleText("\r\n  hello\r\n")).toBe("hello");
	});

	it("splits lines with optional trimming", () => {
		expect(splitChronicleLines("a\r\nb\n")).toEqual(["a", "b", ""]);
		expect(splitChronicleLines("\n a \n\n", { trim: true })).toEqual(["a"]);
	});

	it("formats compact token counts", () => {
		expect(formatCompactTokenCount(999)).toBe("999");
		expect(formatCompactTokenCount(1500)).toBe("1.5k");
	});
});
