import type { LlmTurnDefinition } from "@leitwerk-dev/process-sdk";
import { FakeLlmProvider } from "@leitwerk-dev/test-support";
import { createManualWorkerRuntimeScheduler } from "@leitwerk-dev/test-support/worker-testing";
import { expect, it, vi } from "vitest";
import { executeLogicalPromptPlan, type LogicalTurnPromptPlan } from "./logical-prompt-runner.js";
import { runMissingToolRecovery } from "./missing-tool-recovery-runner.js";
import { createPiProviderFixture } from "./test-helpers/pi-provider.js";
import {
	createTurnOutcomeToolSession,
	type ToolCompletionSnapshot,
} from "./turn-outcome-tool-session.js";

const defaultTurnDef: LlmTurnDefinition<"plan_saved", unknown, unknown> = {
	kind: "llm",
	description: "Save a grounded plan",
	availableTools: [],
	branchType: "primary",
	context: "fresh",
	prompt: () => "Save the plan",
	outcomes: {
		plan_saved: {
			description: "Submit the plan",
			parameters: { citation: { type: "string", required: true } },
		},
	},
	turnResultMarkdown: { mode: "outcome_tool_argument", parameterName: "markdown", required: true },
};

async function fixture(
	llm: FakeLlmProvider,
	turnDef = defaultTurnDef,
	validation?: (params: Record<string, unknown>) => string[],
) {
	const piHandle = await createPiProviderFixture((_request, body) => llm.respond(body));
	const validateOutcome = vi.fn(async ({ params }: { params: Record<string, unknown> }) =>
		validation
			? validation(params)
			: params.citation === "captured"
				? []
				: ["Use a captured citation"],
	);
	const toolSession = createTurnOutcomeToolSession({ turnId: "plan", turnDef, validateOutcome });
	const reportFailedTurn = vi.fn(
		async (_errorClass: string, message: string, _entryId: string | null) => {
			throw new Error(message);
		},
	);
	const execute = (
		plan: LogicalTurnPromptPlan,
		options?: { baseState?: ToolCompletionSnapshot<"plan_saved"> },
	) =>
		executeLogicalPromptPlan({
			plan,
			baseState: options?.baseState,
			turnId: "plan",
			turnRecordId: "plan-record",
			piHandle,
			turnDef,
			toolSession,
			scheduler: createManualWorkerRuntimeScheduler(),
			reportFailedTurn,
		});
	const run = async () => {
		const initialAttempt = await execute({ kind: "prompt", promptText: "Save the plan" });
		return runMissingToolRecovery({
			turnId: "plan",
			turnRecordId: "plan-record",
			piHandle,
			toolSession,
			initialAttempt,
			executeLogicalPromptPlan: execute,
		});
	};
	return { run, piHandle, toolSession, validateOutcome, reportFailedTurn };
}

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
	const f = await fixture(llm);
	await expect(f.run()).rejects.toThrow(
		"Turn aborted by LLM: Pinned dependency cannot be downloaded",
	);
	const [errorClass, reason, entryId] = f.reportFailedTurn.mock.calls[0];
	expect(errorClass).toBe("llm_error");
	expect(reason).toContain("Pinned dependency cannot be downloaded");
	expect(f.piHandle.getEntry(entryId ?? "")).toBeDefined();
	expect(f.reportFailedTurn).toHaveBeenCalledOnce();
	expect(f.validateOutcome).not.toHaveBeenCalled();
	expect(f.toolSession.getCompletionState().selectedOutcome).toBeNull();
	expect(f.toolSession.getCompletionState().markdownState.publicationCount).toBe(0);
	expect(llm.calls).toHaveLength(1);
});

it.each([
	["business validation", { citation: "invented", markdown: "## Plan" }, "Use a captured citation"],
	["argument schema", { citation: { invalid: true }, markdown: "## Plan" }, "citation"],
	["result Markdown", { citation: "captured", markdown: "" }, "markdown"],
] as const)("bounds repeated %s rejections inside the real Pi tool loop", async (_kind, args, error) => {
	const llm = new FakeLlmProvider();
	llm.onPrompt(() =>
		llm.calls.length > 4
			? { content: "Unexpected extra model call" }
			: { content: "", toolCalls: [{ name: "plan_saved", arguments: args }] },
	);
	const f = await fixture(llm);
	const result = await f.run();
	expect(llm.calls).toHaveLength(3);
	expect(result.failure?.recoveryContext.failureCode).toBe("outcome_rejected");
	expect(result.failure?.recoveryContext.suggestedContinuePrompt).toContain(error);
	expect(result.finalAttempt.resolvedOutcome).toBeNull();
	expect(result.finalAttempt.completionState.markdownState.publicationCount).toBe(0);
	expect(
		f.piHandle.getEntry(result.finalAttempt.promptResult.resultEntryId ?? "")?.message,
	).toMatchObject({
		role: "toolResult",
		toolName: "plan_saved",
	});
	if (_kind === "argument schema") expect(f.validateOutcome).not.toHaveBeenCalled();
});

it("accepts a corrected submission and its acknowledgement after returning to recovery", async () => {
	const llm = new FakeLlmProvider();
	llm.onPrompt(() => ({
		content: "",
		toolCalls: [{ name: "plan_saved", arguments: { citation: "invented", markdown: "Rejected" } }],
	}));
	llm.onPrompt(() => ({
		content: "",
		toolCalls: [{ name: "plan_saved", arguments: { citation: "captured", markdown: "## Plan" } }],
	}));
	llm.onPrompt(() => ({ content: "done" }));
	const f = await fixture(llm);
	const result = await f.run();
	expect(llm.calls).toHaveLength(3);
	expect(llm.calls[1]).toContain("Use a captured citation");
	expect(result.failure).toBeUndefined();
	expect(result.finalAttempt.resolvedOutcome).toEqual({
		outcome: "plan_saved",
		params: { citation: "captured" },
	});
	expect(result.finalAttempt.completionState.markdownState.markdown).toBe("## Plan");
});

it("corrects a union submission through real Pi without publishing the rejected attempt", async () => {
	const llm = new FakeLlmProvider();
	llm.onPrompt(() => ({
		content: "",
		toolCalls: [
			{
				name: "plan_saved",
				arguments: { action: { kind: "skip", text: "unwanted placeholder" }, markdown: "Rejected" },
			},
		],
	}));
	llm.onPrompt(() => ({
		content: "",
		toolCalls: [
			{ name: "plan_saved", arguments: { action: { kind: "skip" }, markdown: "Accepted" } },
		],
	}));
	llm.onPrompt(() => ({ content: "done" }));
	const turn = {
		...defaultTurnDef,
		outcomes: {
			plan_saved: {
				description: "Choose",
				strictSchema: true,
				parameters: {
					action: {
						description: "Action",
						required: true,
						anyOf: [
							{
								type: "object" as const,
								properties: { kind: { type: "string" as const, enum: ["skip"] } },
								required: ["kind"],
								additionalProperties: false,
							},
							{
								type: "object" as const,
								properties: {
									kind: { type: "string" as const, enum: ["write"] },
									text: { type: "string" as const },
								},
								required: ["kind", "text"],
								additionalProperties: false,
							},
						],
					},
				},
			},
		},
	};
	const f = await fixture(llm, turn, () => []);
	const result = await f.run();
	expect(result.failure).toBeUndefined();
	expect(result.finalAttempt.resolvedOutcome?.params).toEqual({ action: { kind: "skip" } });
	expect(result.finalAttempt.completionState.markdownState).toMatchObject({
		markdown: "Accepted",
		publicationCount: 1,
	});
	expect(f.validateOutcome).toHaveBeenCalledTimes(1);
	const request = JSON.parse(llm.calls[0]);
	const tool = request.tools.find(
		(item: { function: { name: string } }) => item.function.name === "plan_saved",
	).function;
	expect(tool.strict).toBe(true);
	expect(tool.parameters.properties.action.anyOf).toHaveLength(2);
	expect(tool.parameters.properties).not.toHaveProperty("resultSummary");
});
