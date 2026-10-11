import type { PiPromptOptions } from "@leitwerk-dev/process-sdk";
import { createManualWorkerRuntimeScheduler } from "@leitwerk-dev/test-support/worker-testing";
import { describe, expect, it, vi } from "vitest";
import type { WorkerOperationEmission } from "./diagnostics.js";
import { executeLogicalPromptPlan } from "./logical-prompt-runner.js";
import type { PiTreeHandle } from "./pi-adapter.js";
import { createTestLlmTurn } from "./test-helpers/llm-turn.js";
import { createTurnOutcomeToolSession } from "./turn-outcome-tool-session.js";

const turnDef = createTestLlmTurn({
	description: "Save a plan",
	prompt: () => "Create a plan",
	turnResultMarkdown: { mode: "outcome_tool_argument", parameterName: "markdown", required: true },
});

describe("executeLogicalPromptPlan terminal acknowledgement", () => {
	it("keeps accepted outcome Markdown and traces an ignored acknowledgement failure", async () => {
		const emissions: WorkerOperationEmission[] = [];
		const toolSession = createTurnOutcomeToolSession({ turnId: "plan", turnDef });
		const prompt = vi.fn(async (_text: string, options: PiPromptOptions) => {
			const outcomeTool = options.tools?.find((tool) => tool.name === "plan_saved");
			await outcomeTool?.execute({ markdown: "## Durable plan" });
			options.terminalAcknowledgement?.markFailed("provider unavailable");
			return {
				startLeafId: "user-1",
				endLeafId: "assistant-error",
				createdEntryIds: ["assistant-error"],
				resultEntryId: "assistant-error",
				assistantMarkdown: null,
			};
		});
		const piHandle = {
			prompt,
			getLeafId: () => "assistant-error",
			getEntry: () => undefined,
			subscribe: () => () => {},
			abortTurn: async () => {},
		} as unknown as PiTreeHandle;

		const result = await executeLogicalPromptPlan({
			plan: { kind: "prompt", promptText: "Create a plan" },
			turnId: "plan",
			turnRecordId: "trn_plan_1",
			piHandle,
			turnDef,
			toolSession,
			scheduler: createManualWorkerRuntimeScheduler(),
			emit: (emission) => emissions.push(emission),
			reportFailedTurn: async () => {
				throw new Error("unexpected failed turn");
			},
		});

		expect(result.resolvedOutcome).toEqual({ outcome: "plan_saved", params: {} });
		expect(result.completionState.markdownState.markdown).toBe("## Durable plan");
		expect(emissions).toContainEqual({
			kind: "trace",
			payload: {
				level: "warn",
				code: "turn.terminal_acknowledgement_failed_ignored",
				message: "provider unavailable",
				turnRecordId: "trn_plan_1",
				turnId: "plan",
			},
		});
	});
});
