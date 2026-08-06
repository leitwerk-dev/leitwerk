import { describe, expect, it } from "vitest";
import { buildPromptHighlightSegments } from "./prompt-highlighting.js";

describe("buildPromptHighlightSegments", () => {
	it("highlights every exact user-input match without changing displayed text", () => {
		const fullPrompt = "Context\nUser said: Fix it\nRepeat: Fix it\nDone";
		const result = buildPromptHighlightSegments({ fullPrompt, userInput: "Fix it" });

		expect(result.matchState).toBe("matched");
		expect(result.segments.map((segment) => segment.text).join("")).toBe(fullPrompt);
		expect(result.segments.filter((segment) => segment.kind === "user_input")).toEqual([
			expect.objectContaining({ text: "Fix it" }),
			expect.objectContaining({ text: "Fix it" }),
		]);
	});

	it("renders the prompt normally when exact matching fails", () => {
		const fullPrompt = "Context around the operator request.";
		const result = buildPromptHighlightSegments({ fullPrompt, userInput: "Different request" });

		expect(result).toEqual({
			matchState: "not_found",
			segments: [{ kind: "context", text: fullPrompt, start: 0, end: fullPrompt.length }],
		});
	});

	it("skips highlighting when the user input is absent or too short", () => {
		const fullPrompt = "Context with a repeated word: a a a.";

		expect(buildPromptHighlightSegments({ fullPrompt, userInput: " a " }).matchState).toBe(
			"skipped",
		);
		expect(buildPromptHighlightSegments({ fullPrompt, userInput: null }).matchState).toBe(
			"skipped",
		);
	});
});
