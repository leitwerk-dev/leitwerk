import { FakeLlmProvider } from "@leitwerk-dev/test-support";
import { createManualWorkerRuntimeScheduler } from "@leitwerk-dev/test-support/worker-testing";
import { expect, it, vi } from "vitest";
import { executeLogicalPromptPlan } from "./logical-prompt-runner.js";
import { createTestLlmTurn } from "./test-helpers/llm-turn.js";
import { createPiProviderFixture } from "./test-helpers/pi-provider.js";
import { createTurnOutcomeToolSession } from "./turn-outcome-tool-session.js";

const turnDef = createTestLlmTurn({
	description: "Save a grounded plan",
	context: "fresh",
	prompt: () => "Save the plan",
	outcomes: {
		plan_saved: {
			description: "Submit the plan",
			parameters: {
				citation: { type: "string", description: "Evidence reference", required: true },
			},
		},
	},
	turnResultMarkdown: { mode: "outcome_tool_argument", parameterName: "markdown", required: true },
});

it("aborts in the real Pi loop without acknowledgement, further tools, or outcome recovery", async () => {
	const llm = new FakeLlmProvider();
	llm.onPrompt(() =>
		llm.calls.length > 1
			? { content: "Unexpected extra model call" }
			: {
					content: "",
					toolCalls: [
						{ name: "abort_turn", arguments: { reason: "Pinned dependency cannot be downloaded" } },
						{
							name: "plan_saved",
							arguments: { citation: "captured", markdown: "Must not publish" },
						},
					],
				},
	);
	const piHandle = await createPiProviderFixture((_request, body) => llm.respond(body));
	const toolSession = createTurnOutcomeToolSession({ turnId: "plan", turnDef });
	const reportFailedTurn = vi.fn(
		async (_errorClass: string, message: string, _entryId: string | null) => {
			throw new Error(message);
		},
	);
	await expect(
		executeLogicalPromptPlan({
			plan: { kind: "prompt", promptText: "Save the plan" },
			turnId: "plan",
			turnRecordId: "plan-record",
			piHandle,
			turnDef,
			toolSession,
			scheduler: createManualWorkerRuntimeScheduler(),
			reportFailedTurn,
		}),
	).rejects.toThrow("Turn aborted by LLM: Pinned dependency cannot be downloaded");
	const [errorClass, reason, entryId] = reportFailedTurn.mock.calls[0];
	expect(errorClass).toBe("llm_error");
	expect(reason).toContain("Pinned dependency cannot be downloaded");
	expect(piHandle.getEntry(entryId ?? "")).toBeDefined();
	expect(reportFailedTurn).toHaveBeenCalledOnce();
	expect(toolSession.getCompletionState().selectedOutcome).toBeNull();
	expect(toolSession.getCompletionState().markdownState.publicationCount).toBe(0);
	expect(llm.calls).toHaveLength(1);
});
