import type { LlmTurnDefinition } from "@leitwerk-dev/process-sdk";
import { describe, expect, it, vi } from "vitest";
import { createTurnOutcomeToolSession } from "./turn-outcome-tool-session.js";

function turnDef(
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

describe("TurnOutcomeToolSession terminal outcome runtime controls", () => {
	it("exposes result image upload only for turns declaring result Markdown", () => {
		const imageTool = {
			name: "upload_result_images",
			description: "upload",
			parameters: {},
			execute: async () => ({}),
		};
		const withoutMarkdown = createTurnOutcomeToolSession({
			turnId: "turn",
			turnDef: turnDef(),
			resultImageTool: imageTool,
		});
		const withMarkdown = createTurnOutcomeToolSession({
			turnId: "turn",
			turnDef: turnDef({ turnResultMarkdown: { mode: "assistant_output" } }),
			resultImageTool: imageTool,
		});
		expect(withoutMarkdown.tools.map((tool) => tool.name)).not.toContain("upload_result_images");
		expect(withoutMarkdown.addPromptSuffix("test")).not.toContain("upload_result_images");
		expect(withMarkdown.tools.map((tool) => tool.name)).toContain("upload_result_images");
		expect(withMarkdown.addPromptSuffix("test")).toContain("upload_result_images");
	});
	it("marks generated outcome tools sequential", () => {
		const session = createTurnOutcomeToolSession({ turnId: "turn", turnDef: turnDef() });

		expect(session.tools.find((tool) => tool.name === "plan_saved")?.executionMode).toBe(
			"sequential",
		);
	});

	it("registers ask_questions and resumes the same tool call with ordered answers", async () => {
		const requestQuestions = vi.fn().mockResolvedValue(["Safe"]);
		const resumeGuards = vi.fn();
		const suspendPromptGuards = vi.fn(() => resumeGuards);
		const session = createTurnOutcomeToolSession({
			turnId: "turn",
			turnRecordId: "turn-record-1",
			turnDef: turnDef({ askQuestions: true }),
			requestQuestions,
		});
		const tool = session.tools.find((candidate) => candidate.name === "ask_questions");

		const result = await tool?.execute(
			{
				questions: [
					{
						question: "Choose a strategy",
						selection: "single",
						options: [{ label: "Safe", details: "Small change" }],
					},
				],
			},
			{
				toolCallId: "tool-call-1",
				signal: new AbortController().signal,
				suspendPromptGuards,
			},
		);

		expect(tool?.executionMode).toBe("sequential");
		expect(tool?.description).toContain("mark one choice as recommended");
		expect(requestQuestions).toHaveBeenCalledWith(
			expect.objectContaining({
				turnRecordId: "turn-record-1",
				toolCallId: "tool-call-1",
				questions: [expect.objectContaining({ id: "question_1", question: "Choose a strategy" })],
			}),
		);
		expect(result).toEqual({ answers: ["Safe"] });
		expect(suspendPromptGuards).toHaveBeenCalledOnce();
		expect(resumeGuards).toHaveBeenCalledOnce();
	});

	it("does not become terminal when outcome markdown validation fails", async () => {
		const session = createTurnOutcomeToolSession({
			turnId: "turn",
			turnDef: turnDef({
				turnResultMarkdown: {
					mode: "outcome_tool_argument",
					parameterName: "markdown",
				},
			}),
		});
		const tool = session.tools.find((candidate) => candidate.name === "plan_saved");
		expect(tool).toBeDefined();

		const result = await tool?.execute({ markdown: "" });

		expect(result).toMatchObject({ ok: false });
		expect(session.getCompletionState().selectedOutcome).toBeNull();
		expect(session.shouldBlockToolCall("bash")).toBeNull();
	});

	it("waits for one acknowledgement while preserving outcome Markdown", async () => {
		const session = createTurnOutcomeToolSession({
			turnId: "turn",
			turnDef: turnDef({
				turnResultMarkdown: {
					mode: "outcome_tool_argument",
					parameterName: "markdown",
				},
			}),
		});
		const tool = session.tools.find((candidate) => candidate.name === "plan_saved");
		expect(tool).toBeDefined();

		const result = await tool?.execute({ summary: "accepted", markdown: "## Plan" });

		expect(session.getCompletionState()).toMatchObject({
			selectedOutcome: {
				outcome: "plan_saved",
				params: { summary: "accepted" },
			},
		});
		expect(result).toEqual({ status: "ok", outcome: "plan_saved" });
		expect(session.shouldBlockToolCall("bash")).toContain("already been accepted");

		session.terminalAcknowledgement.markSucceeded();

		const completionState = session.getCompletionState();
		expect(session.terminalAcknowledgement.state()).toBe("acknowledgement_succeeded");
		expect(session.finalizeMarkdown(completionState, "done")).toMatchObject({
			markdown: "## Plan",
		});
	});

	it("records acknowledgement failure without discarding the accepted outcome", async () => {
		const session = createTurnOutcomeToolSession({ turnId: "turn", turnDef: turnDef() });
		const tool = session.tools.find((candidate) => candidate.name === "plan_saved");
		await tool?.execute({ summary: "accepted" });

		session.terminalAcknowledgement.markFailed("provider unavailable");

		expect(session.terminalAcknowledgement.state()).toBe("acknowledgement_failed_ignored");
		expect(session.getCompletionState()).toMatchObject({
			selectedOutcome: { outcome: "plan_saved" },
		});
		expect(session.terminalAcknowledgement.failureReason()).toBe("provider unavailable");
	});

	it("allows missing markdown recovery publication after an outcome was selected", () => {
		const session = createTurnOutcomeToolSession({
			turnId: "turn",
			turnDef: turnDef({
				turnResultMarkdown: {
					mode: "tool_call",
					toolName: "markdown_result",
					required: true,
				},
			}),
		});

		session.reset({
			selectedOutcome: { outcome: "plan_saved", params: {} },
			markdownState: { markdown: null, publicationCount: 0 },
		});

		expect(session.shouldBlockToolCall("markdown_result")).toBeNull();
		expect(session.shouldBlockToolCall("bash")).toContain("already been accepted");
	});
});
