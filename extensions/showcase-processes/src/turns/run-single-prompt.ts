import {
	type LlmTurnDefinition,
	llmTurn,
	REQUIRED_MARKDOWN_RESULT_TURN_RESULT,
} from "@leitwerk-dev/process-sdk";

export function buildSinglePromptInstruction(promptText: string): string {
	return `Run the following one-shot operator prompt exactly once.

${promptText}`;
}

export function buildSinglePromptWithToolInstruction(promptText: string): string {
	return `Run the following one-shot operator prompt exactly once.

${promptText}

When you are done, call the done tool with a short summary of the result.`;
}

export function createRunSinglePromptTurn(promptText: string): LlmTurnDefinition<"completed"> {
	return llmTurn({
		description: "Run a single operator-provided prompt and finish on turn end",
		availableTools: ["read", "bash", "edit", "write"],
		completionMode: "turn_end",
		branchType: "primary",
		context: "fresh",
		prompt: () => buildSinglePromptInstruction(promptText),
		outcomes: {},
		turnEnd: {
			outcome: "completed",
			params: {},
			complete: true,
		},
		turnResultMarkdown: REQUIRED_MARKDOWN_RESULT_TURN_RESULT,
	});
}

export function createRunSinglePromptWithToolTurn(promptText: string): LlmTurnDefinition<"done"> {
	return llmTurn({
		description: "Run a single operator-provided prompt and require the done tool",
		availableTools: ["read", "bash", "edit", "write"],
		completionMode: "turn_end",
		branchType: "primary",
		context: "fresh",
		prompt: () => buildSinglePromptWithToolInstruction(promptText),
		outcomes: {
			done: {
				description: "Mark the prompt run as complete",
				parameters: {
					summary: {
						type: "string",
						description: "Short summary of the result",
						required: true,
						requiredErrorCode: "summary_required",
					},
				},
			},
		},
		turnResultMarkdown: REQUIRED_MARKDOWN_RESULT_TURN_RESULT,
	});
}

export const runSinglePrompt = createRunSinglePromptTurn(
	"Run the operator-provided single prompt.",
);

export const runSinglePromptWithTool = createRunSinglePromptWithToolTurn(
	"Run the operator-provided single prompt.",
);
