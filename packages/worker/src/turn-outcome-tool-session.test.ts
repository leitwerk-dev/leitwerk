import { describe, expect, it, vi } from "vitest";
import { createTestLlmTurn as turnDef } from "./test-helpers/llm-turn.js";
import { createTurnOutcomeToolSession } from "./turn-outcome-tool-session.js";

function createSession(overrides: Parameters<typeof turnDef>[0] = {}) {
	return createTurnOutcomeToolSession({
		turnId: "turn",
		turnDef: turnDef({
			outcomes: {
				plan_saved: { description: "Save", parameters: { summary: { type: "string" } } },
			},
			...overrides,
		}),
	});
}

describe("TurnOutcomeToolSession terminal outcome runtime controls", () => {
	it("aborts without accepting an outcome or requiring result Markdown", async () => {
		const session = createSession({
			turnResultMarkdown: {
				mode: "outcome_tool_argument",
				parameterName: "markdown",
				required: true,
			},
		});
		const abort = session.tools.find((tool) => tool.name === "abort_turn");
		if (!abort) throw new Error("Missing abort_turn tool");
		await abort.execute({ reason: "  Dependency access is unavailable  " });
		expect(session.getCompletionState().abortReason).toBe("Dependency access is unavailable");
		expect(session.recordToolResult({ role: "toolResult", toolName: "abort_turn" })).toBe(true);
		expect(session.shouldBlockToolCall("write")).toContain("aborted");
		expect(session.shouldBlockToolCall("plan_saved")).toContain("aborted");
		expect(session.resolveOutcome(turnDef())).toBeNull();
		expect(session.resolveMissingToolRecovery(session.getCompletionState())).toBeNull();
		expect(session.getCompletionState().markdownState.publicationCount).toBe(0);
		expect(session.terminalAcknowledgement.state()).toBe("open");
		session.reset();
		expect(session.getCompletionState().abortReason).toBeUndefined();
		expect(session.shouldBlockToolCall("write")).toBeNull();
	});

	it("rejects blank abort reasons and cannot replace an accepted outcome", async () => {
		const session = createSession();
		const abort = session.tools.find((tool) => tool.name === "abort_turn");
		if (!abort) throw new Error("Missing abort_turn tool");
		expect(await abort.execute({ reason: "   " })).toMatchObject({ ok: false });
		expect(session.getCompletionState().abortReason).toBeUndefined();
		await session.tools.find((tool) => tool.name === "plan_saved")?.execute({});
		expect(session.shouldBlockToolCall("abort_turn")).toContain(
			"outcome has already been accepted",
		);
		expect(await abort.execute({ reason: "Too late" })).toMatchObject({ ok: false });
		expect(session.getCompletionState().abortReason).toBeUndefined();
		expect(session.resolveOutcome(turnDef())?.outcome).toBe("plan_saved");
	});

	it("provides the abort escape even for turns with no outcome tools", async () => {
		const definition = turnDef({ outcomes: undefined, turnEnd: { outcome: "done" } });
		const session = createTurnOutcomeToolSession({ turnId: "turn", turnDef: definition });
		await session.tools.find((tool) => tool.name === "abort_turn")?.execute({ reason: "Blocked" });
		expect(session.resolveOutcome(definition)).toBeNull();
		expect(session.addPromptSuffix("Work")).toContain("instead of a success outcome");
	});

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
		const session = createSession();

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

	it.each([true, false])("constrains question tools and guidance when enabled=%s", (enabled) => {
		const session = createTurnOutcomeToolSession({
			turnId: "turn",
			turnRecordId: "turn-record-1",
			turnDef: turnDef({ askQuestions: true }),
			questionsEnabled: enabled,
			requestQuestions: vi.fn(),
		});
		expect(session.tools.some((tool) => tool.name === "ask_questions")).toBe(enabled);
		expect(session.addPromptSuffix("Work").includes("ask_questions")).toBe(enabled);
		expect(session.tools.some((tool) => tool.name === "plan_saved")).toBe(true);
		expect(session.tools.some((tool) => tool.name === "abort_turn")).toBe(true);
	});

	it("does not become terminal when outcome markdown validation fails", async () => {
		const session = createSession({
			turnResultMarkdown: {
				mode: "outcome_tool_argument",
				parameterName: "markdown",
			},
		});
		const tool = session.tools.find((candidate) => candidate.name === "plan_saved");
		expect(tool).toBeDefined();

		const result = await tool?.execute({ markdown: "" });

		expect(result).toMatchObject({ ok: false });
		expect(session.getCompletionState().selectedOutcome).toBeNull();
		expect(session.shouldBlockToolCall("bash")).toBeNull();
	});

	it("waits for one acknowledgement while preserving outcome Markdown", async () => {
		const session = createSession({
			turnResultMarkdown: {
				mode: "outcome_tool_argument",
				parameterName: "markdown",
			},
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
		const session = createSession();
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
		const session = createSession({
			turnResultMarkdown: {
				mode: "tool_call",
				toolName: "markdown_result",
				required: true,
			},
		});

		session.reset({
			selectedOutcome: { outcome: "plan_saved", params: {} },
			markdownState: { markdown: null, publicationCount: 0 },
		});

		expect(session.shouldBlockToolCall("markdown_result")).toBeNull();
		expect(session.shouldBlockToolCall("bash")).toContain("already been accepted");
	});
});

it("keeps invalid submissions open and accepts a correction in the same tool session", async () => {
	const validateOutcome = vi.fn(async ({ params }: { params: Record<string, unknown> }) =>
		params.citation === "captured" ? [] : ["Citation must match the captured commit"],
	);
	const session = createTurnOutcomeToolSession({
		turnId: "investigate",
		turnDef: turnDef({
			outcomes: {
				plan_saved: { description: "Save", parameters: { citation: { type: "string" } } },
			},
		}),
		validateOutcome,
	});
	const tool = session.tools.find((tool) => tool.name === "plan_saved")!;
	expect(await tool.execute({ citation: "invented" })).toEqual({
		ok: false,
		status: "invalid",
		errors: ["Citation must match the captured commit"],
	});
	expect(session.getCompletionState().selectedOutcome).toBeNull();
	expect(session.getCompletionState().markdownState.publicationCount).toBe(0);
	expect(session.terminalAcknowledgement.state()).toBe("open");
	expect(session.shouldBlockToolCall("read")).toBeNull();
	expect(await tool.execute({ citation: "captured" })).toEqual({
		status: "ok",
		outcome: "plan_saved",
	});
	expect(session.resolveOutcome(turnDef())).toEqual({
		outcome: "plan_saved",
		params: { citation: "captured" },
	});
	expect(session.terminalAcknowledgement.state()).toBe("outcome_accepted");
});

it("returns validation exceptions as feedback without accepting an outcome", async () => {
	const session = createTurnOutcomeToolSession({
		turnId: "investigate",
		turnDef: turnDef(),
		validateOutcome: async () => {
			throw new Error("Source unavailable; name the missing access in a blocked assessment");
		},
	});
	const result = await session.tools.find((tool) => tool.name === "plan_saved")!.execute({});
	expect(result).toEqual({
		ok: false,
		status: "invalid",
		errors: ["Source unavailable; name the missing access in a blocked assessment"],
	});
	expect(session.resolveOutcome(turnDef())).toBeNull();
});

it("retains rejection feedback across recovery and clears it when corrected", async () => {
	const session = createTurnOutcomeToolSession({
		turnId: "turn",
		turnDef: turnDef({
			outcomes: { plan_saved: { description: "Save", parameters: { valid: { type: "boolean" } } } },
		}),
		validateOutcome: async ({ params }) => (params.valid ? [] : ["assessment.ticket: unsupported"]),
	});
	await session.tools[0].execute({});
	const state = session.getCompletionState();
	session.reset(state);
	const recovery = session.resolveMissingToolRecovery(session.getCompletionState())!;
	expect(recovery.failureCode).toBe("outcome_rejected");
	expect(session.buildRecoveryContext(recovery).suggestedContinuePrompt).toContain(
		"assessment.ticket: unsupported",
	);
	await session.tools[0].execute({ valid: true });
	expect(session.getCompletionState().rejectedOutcome).toBeUndefined();
	expect(session.resolveMissingToolRecovery(session.getCompletionState())).toBeNull();
});

it("recognizes Pi schema rejections before the outcome execute callback", () => {
	const session = createTurnOutcomeToolSession({ turnId: "turn", turnDef: turnDef() });
	const entry = {
		id: "result",
		parentId: "call",
		type: "message",
		timestamp: "2026-10-07T10:29:21Z",
		message: {
			role: "toolResult",
			toolName: "plan_saved",
			isError: true,
			content: [{ type: "text", text: "assessment.findings must be an object" }],
		},
	};
	expect(session.recordToolResult(entry.message)).toBe(true);
	const recovery = session.resolveMissingToolRecovery(session.getCompletionState())!;
	expect(recovery.rejectedOutcome?.errors).toEqual(["assessment.findings must be an object"]);
	expect(session.describeRecovery(recovery)).toContain("rejected 'plan_saved'");
});

it("distinguishes a new outcome rejection from unrelated tool failures during correction", async () => {
	const session = createTurnOutcomeToolSession({
		turnId: "turn",
		turnDef: turnDef({
			outcomes: { plan_saved: { description: "Save", parameters: { valid: { type: "boolean" } } } },
		}),
		validateOutcome: async ({ params }) => (params.valid ? [] : ["Use a captured citation"]),
	});
	const tool = session.tools[0];
	const details = await tool.execute({});
	expect(session.recordToolResult({ role: "toolResult", toolName: "plan_saved", details })).toBe(
		true,
	);
	session.reset(session.getCompletionState());
	expect(session.recordToolResult({ role: "toolResult", toolName: "read", isError: true })).toBe(
		false,
	);
	expect(session.recordToolResult(undefined)).toBe(false);
	expect(session.getCompletionState().rejectedOutcome?.errors).toEqual(["Use a captured citation"]);
	await tool.execute({ valid: true });
	expect(session.recordToolResult({ role: "toolResult", toolName: "plan_saved", details })).toBe(
		false,
	);
	expect(session.getCompletionState().rejectedOutcome).toBeUndefined();
});

it("keeps runtime-only integration tools out of model declarations", () => {
	const hidden = {
		name: "validate_internal",
		description: "Validate",
		modelVisible: false,
		parameters: {},
		execute: async () => ({ ok: true }),
	};
	const visible = { ...hidden, name: "lookup", modelVisible: true };
	const session = createTurnOutcomeToolSession({
		turnId: "turn",
		turnDef: turnDef(),
		integrationTools: [hidden, visible],
	});
	expect(session.tools.map((tool) => tool.name)).toContain("lookup");
	expect(session.tools.map((tool) => tool.name)).not.toContain("validate_internal");
});
