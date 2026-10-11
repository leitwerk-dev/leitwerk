import type { LlmTurnDefinition } from "@leitwerk-dev/process-sdk";

/** @internal */
export function createTestLlmTurn(
	overrides: Partial<LlmTurnDefinition<"plan_saved" | "done", unknown, unknown>> = {},
): LlmTurnDefinition<"plan_saved" | "done", unknown, unknown> {
	return {
		kind: "llm",
		description: "test turn",
		availableTools: [],
		branchType: "primary",
		context: "full",
		prompt: () => "test",
		outcomes: {
			plan_saved: {
				description: "save plan",
				parameters: {},
			},
		},
		...overrides,
	};
}
