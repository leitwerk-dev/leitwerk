import { describe, expect, it } from "vitest";
import { presentTurnResult } from "./result-presentation.js";

describe("result presentation", () => {
	it("does not repeat a summary already at the start of the formatted report", () => {
		expect(
			presentTurnResult("**PR #53** updated.\n\n## Checks\n\nPassed.", "PR #53 updated."),
		).toMatchObject({
			preview: "PR #53 updated.",
			separateSummary: null,
			headings: ["Checks"],
		});
	});
	it("keeps a distinct recorded summary and exposes limitations in the outline", () => {
		expect(
			presentTurnResult(
				"Implemented the links.\n\nWhat changed\n- Shared component.\n\nValidation limitations\n- Tests could not start.",
				"Ready for review.",
			),
		).toEqual({
			preview: "Ready for review.",
			separateSummary: "Ready for review.",
			headings: ["What changed", "Validation limitations"],
		});
	});
	it("ignores headings in code and quotes and bounds previews without changing the report", () => {
		const result = presentTurnResult(
			`## Outcome\n\n${"Long result. ".repeat(80)}\n\n\`\`\`md\n# Fake heading\n\`\`\`\n\n> ## Quoted heading`,
		);
		expect(result.headings).toEqual(["Outcome"]);
		expect(result.preview.length).toBeLessThanOrEqual(321);
	});
});
