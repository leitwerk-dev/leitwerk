import { type NormalizedQuestion, normalizeAskQuestionsInput } from "@leitwerk-dev/domain";
import type { PiCustomTool } from "@leitwerk-dev/process-sdk";

export interface WorkerQuestionRequest {
	turnRecordId: string;
	toolCallId: string;
	questions: NormalizedQuestion[];
	signal: AbortSignal;
}

export function createAskQuestionsTool(input: {
	turnRecordId: string;
	request(request: WorkerQuestionRequest): Promise<string[]>;
}): PiCustomTool {
	return {
		name: "ask_questions",
		description:
			"Pause this turn to ask the operator one or more focused questions. For every question, provide distinct prepared choices, clearly mark one choice as recommended in its label, and explain why in its details. The same turn resumes with one free-text answer per question.",
		executionMode: "sequential",
		parameters: {
			questions: {
				type: "array",
				description: "Questions to present in order",
				required: true,
				items: {
					type: "object",
					properties: {
						question: { type: "string" },
						selection: { type: "string", enum: ["single", "multiple"] },
						options: {
							type: "array",
							items: {
								type: "object",
								properties: {
									label: { type: "string" },
									details: { type: "string" },
								},
								required: ["label"],
							},
						},
					},
					required: ["question", "selection", "options"],
				},
			},
		},
		async execute(args, context) {
			if (!context) throw new Error("ask_questions requires a correlated tool-call context");
			const questions = normalizeAskQuestionsInput(args);
			const resumeGuards = context.suspendPromptGuards?.();
			try {
				const answers = await input.request({
					turnRecordId: input.turnRecordId,
					toolCallId: context.toolCallId,
					questions,
					signal: context.signal,
				});
				return { answers };
			} finally {
				resumeGuards?.();
			}
		},
	};
}

export const ASK_QUESTIONS_PROMPT_GUIDANCE = `\n\nOperator questions:\n- Use ask_questions only when an operator decision would materially improve this turn.\n- Ask focused questions with distinct prepared options. For each question, clearly mark one option as recommended in its label and explain why in its details; do not guess after calling it.\n- The tool pauses this same turn and returns answers in question order. You may call it again for a follow-up after it returns.\n`;
