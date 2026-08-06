import { describe, expect, it } from "vitest";
import {
	canonicalizeQuestionAnswers,
	emptyQuestionDrafts,
	normalizeAskQuestionsInput,
} from "./domain-model.js";

describe("ask_questions contract", () => {
	it("normalizes stable ids and canonicalizes ordered answers", () => {
		const questions = normalizeAskQuestionsInput({
			questions: [
				{
					question: " Choose a strategy ",
					selection: "single",
					options: [{ label: "Safe", details: "Small change" }, { label: "Bold" }],
				},
				{
					question: "Which checks?",
					selection: "multiple",
					options: [{ label: "Unit" }, { label: "System" }],
				},
			],
		});
		expect(questions[0]?.id).toBe("question_1");
		expect(questions[0]?.options[1]?.id).toBe("question_1_option_2");
		const draft = emptyQuestionDrafts(questions);
		draft[0] = {
			...draft[0],
			selectedOptionIds: ["question_1_option_2"],
			comment: "Time matters",
		};
		draft[1] = { ...draft[1], freeText: "Run the focused integration suite" };
		expect(canonicalizeQuestionAnswers(questions, draft)).toEqual([
			"Bold\nContext: Time matters",
			"Run the focused integration suite",
		]);
	});

	it("rejects empty and duplicate options and malformed answers", () => {
		expect(() =>
			normalizeAskQuestionsInput({
				questions: [
					{
						question: "Pick",
						selection: "single",
						options: [{ label: "Same" }, { label: " same " }],
					},
				],
			}),
		).toThrow(/duplicate option/);
		const questions = normalizeAskQuestionsInput({
			questions: [{ question: "Pick", selection: "single", options: [{ label: "One" }] }],
		});
		expect(() => canonicalizeQuestionAnswers(questions, emptyQuestionDrafts(questions))).toThrow(
			/requires an answer/,
		);
	});
});
