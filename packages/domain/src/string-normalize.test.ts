import { describe, expect, it } from "vitest";
import {
	formatProcessIdentifier,
	humanizeProcessLabel,
	readNonBlankString,
	toErrorMessage,
} from "./string-normalize.js";

it.each([
	["  text\n", "  text\n"],
	["", null],
	[" \t\n", null],
	[null, null],
	[undefined, null],
	[42, null],
	[{}, null],
	[[], null],
])("reads non-blank string %j verbatim", (value, expected) => {
	expect(readNonBlankString(value)).toBe(expected);
});

it.each([
	[new Error("  reason  "), "  reason  "],
	[new Error(""), "Error"],
	[new Error("  "), "Error:   "],
	["", ""],
	[null, "null"],
	[undefined, "undefined"],
	[42, "42"],
])("formats diagnostic %j without trimming non-empty messages", (value, expected) => {
	expect(toErrorMessage(value)).toBe(expected);
});

it.each([
	["api_id_llm_mr_pi_ui", "API ID LLM MR Pi UI"],
	["review__MR--status", "Review MR Status"],
	["camelCase_value", "CamelCase Value"],
	["already spaced", "Already spaced"],
	["", ""],
])("formats identifier %j without changing its spelling", (value, expected) => {
	expect(formatProcessIdentifier(value)).toBe(expected);
});

describe("humanizeProcessLabel", () => {
	it("turns snake_case ids into Title Case", () => {
		expect(humanizeProcessLabel("approve_plan")).toBe("Approve Plan");
	});

	it("turns kebab-case ids into Title Case", () => {
		expect(humanizeProcessLabel("run-automated-review")).toBe("Run Automated Review");
	});

	it("collapses repeated and mixed separators", () => {
		expect(humanizeProcessLabel("no__issues--found")).toBe("No Issues Found");
	});

	it("trims surrounding whitespace and non-string input", () => {
		expect(humanizeProcessLabel("  finalize_change  ")).toBe("Finalize Change");
		expect(humanizeProcessLabel(undefined)).toBe("");
		expect(humanizeProcessLabel(null)).toBe("");
	});

	it("leaves an already-spaced label capitalized per word", () => {
		expect(humanizeProcessLabel("plan saved")).toBe("Plan Saved");
	});
});
