import type { LlmTurnDefinition } from "@leitwerk-dev/process-sdk";
import { expect, it, vi } from "vitest";
import type { LogicalPromptAttempt, LogicalTurnPromptPlan } from "./logical-prompt-runner.js";
import { runMissingToolRecovery } from "./missing-tool-recovery-runner.js";
import type { PiTreeHandle } from "./pi-adapter.js";
import {
	createTurnOutcomeToolSession,
	type ToolCompletionSnapshot,
} from "./turn-outcome-tool-session.js";

function fixture() {
	const turnDef: LlmTurnDefinition<"done", unknown, unknown> = {
		kind: "llm",
		description: "Save findings",
		availableTools: [],
		branchType: "primary",
		context: "full",
		prompt: () => "Investigate",
		outcomes: {
			done: {
				description: "Save",
				parameters: {
					error: { type: "string", description: "Validation feedback for this attempt" },
					valid: { type: "boolean", description: "Whether the submission is valid" },
				},
			},
		},
	};
	const toolSession = createTurnOutcomeToolSession({
		turnId: "investigate",
		turnDef,
		validateOutcome: async ({ params }) =>
			params.valid ? [] : [String(params.error ?? "assessment.findings: expected an object")],
	});
	const tool = toolSession.tools[0];
	const branch = vi.fn(async () => {});
	const piHandle = { branch } as unknown as PiTreeHandle;
	const attempt = (id: string): LogicalPromptAttempt<"done"> => ({
		completionState: toolSession.getCompletionState(),
		resolvedOutcome: toolSession.resolveOutcome(turnDef),
		promptResult: {
			startLeafId: null,
			endLeafId: id,
			resultEntryId: id,
			createdEntryIds: [id],
			assistantMarkdown: null,
		},
	});
	return { toolSession, tool, branch, piHandle, attempt };
}

it("continues from each rejected attempt with its latest validation feedback", async () => {
	const f = fixture();
	await f.tool.execute({ error: "assessment.ticket: unsupported" });
	const initialAttempt = f.attempt("initial");
	const prompts: string[] = [];
	const execute = vi.fn(
		async (
			plan: LogicalTurnPromptPlan,
			options?: { baseState?: ToolCompletionSnapshot<"done"> },
		) => {
			if (plan.kind !== "continue") throw new Error("Expected continuation");
			await plan.prepareForContinuation?.();
			prompts.push(plan.continueUserPrompt ?? "");
			f.toolSession.reset(options?.baseState);
			await f.tool.execute(
				prompts.length === 1
					? { error: "assessment.evidence[0].excerpt: required" }
					: { valid: true },
			);
			return f.attempt(`correction-${prompts.length}`);
		},
	);
	const result = await runMissingToolRecovery({
		...f,
		turnId: "investigate",
		turnRecordId: "record",
		initialAttempt,
		executeLogicalPromptPlan: execute,
	});
	expect(prompts[0]).toContain("submission was rejected");
	expect(prompts[0]).toContain("assessment.ticket: unsupported");
	expect(prompts[1]).toContain("assessment.evidence[0].excerpt: required");
	expect(prompts[1]).not.toContain("missed required tool calls");
	expect(f.branch.mock.calls).toEqual([["initial"], ["correction-1"]]);
	expect(result.failure).toBeUndefined();
	expect(result.finalAttempt.resolvedOutcome?.outcome).toBe("done");
});

it("bounds repeated identical rejections and keeps the last failed attempt", async () => {
	const f = fixture();
	await f.tool.execute({});
	const initialAttempt = f.attempt("initial");
	let count = 0;
	const result = await runMissingToolRecovery({
		...f,
		turnId: "investigate",
		turnRecordId: "record",
		initialAttempt,
		executeLogicalPromptPlan: async (plan, options) => {
			if (plan.kind === "continue") await plan.prepareForContinuation?.();
			f.toolSession.reset(options?.baseState);
			await f.tool.execute({});
			return f.attempt(`rejected-${++count}`);
		},
	});
	expect(count).toBe(2);
	expect(result.finalAttempt.promptResult.resultEntryId).toBe("rejected-2");
	expect(result.failure?.recoveryContext.failureCode).toBe("outcome_rejected");
	expect(result.failure?.recoveryContext.suggestedContinuePrompt).toContain("assessment.findings");
});
