import type { NormalizedQuestion, ProcessQuestionRequest } from "@leitwerk-dev/domain";

export function createTestQuestion(
	overrides: Partial<NormalizedQuestion> = {},
): NormalizedQuestion {
	return {
		id: "question_1",
		question: "Choose a strategy",
		selection: "single",
		options: [{ id: "question_1_option_1", label: "Safe", details: "Small change" }],
		...overrides,
	};
}

export function createTestQuestionRequest(
	overrides: Partial<ProcessQuestionRequest> = {},
): ProcessQuestionRequest {
	return {
		id: "qst_1",
		instanceId: "agt_1",
		turnRecordId: "trn_1",
		toolCallId: "tool_1",
		questions: [createTestQuestion()],
		status: "open",
		answers: null,
		askedAt: "2026-01-01T00:00:00.000Z",
		answeredAt: null,
		answeredBy: null,
		cancelledAt: null,
		...overrides,
	};
}
