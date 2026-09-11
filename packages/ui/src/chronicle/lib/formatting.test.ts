import { describe, expect, it } from "vitest";
import {
	formatChronicleCost,
	formatChronicleDuration,
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
	it("distinguishes sub-cent usage from a free turn", () => {
		expect(formatChronicleCost(0)).toBe("$0.00");
		expect(formatChronicleCost(0.0004)).toBe("<$0.01");
		expect(formatChronicleCost(0.03)).toBe("$0.03");
	});

	it("uses fractional seconds and omits unknown or invalid duration", () => {
		expect(formatChronicleDuration("2026-09-10T10:00:00Z", "2026-09-10T10:00:03.400Z")).toBe(
			"3.4s",
		);
		expect(formatChronicleDuration("2026-09-10T10:00:00Z", "2026-09-10T10:01:03Z")).toBe("1m 3s");
		expect(formatChronicleDuration(null, null)).toBeNull();
		expect(formatChronicleDuration("bad", "bad")).toBeNull();
		expect(formatChronicleDuration("2026-09-10T10:01:00Z", "2026-09-10T10:00:00Z")).toBeNull();
	});
});
