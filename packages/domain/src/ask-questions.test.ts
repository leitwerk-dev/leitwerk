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
		expect(questions).toEqual([
			{
				id: "question_1",
				question: "Choose a strategy",
				selection: "single",
				options: [
					{ id: "question_1_option_1", label: "Safe", details: "Small change" },
					{ id: "question_1_option_2", label: "Bold", details: null },
				],
			},
			{
				id: "question_2",
				question: "Which checks?",
				selection: "multiple",
				options: [
					{ id: "question_2_option_1", label: "Unit", details: null },
					{ id: "question_2_option_2", label: "System", details: null },
				],
			},
		]);
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

	it("rejects duplicate option labels regardless of case or surrounding whitespace", () => {
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
	});

	it("rejects a question with neither a selected option nor free text", () => {
		const questions = normalizeAskQuestionsInput({
			questions: [{ question: "Pick", selection: "single", options: [{ label: "One" }] }],
		});
		expect(() => canonicalizeQuestionAnswers(questions, emptyQuestionDrafts(questions))).toThrow(
			/requires an answer/,
		);
	});
});
