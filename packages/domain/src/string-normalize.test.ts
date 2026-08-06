import { describe, expect, it } from "vitest";
import { humanizeProcessLabel } from "./string-normalize.js";

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
