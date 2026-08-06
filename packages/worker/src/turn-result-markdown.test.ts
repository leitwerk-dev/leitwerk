import { describe, expect, it } from "vitest";
import {
	buildMissingTurnToolCallRecoveryPrompt,
	buildTurnResultMarkdownPromptSuffix,
	buildTurnToolCallPromptSuffix,
	createMarkdownResultTool,
	createTurnResultMarkdownState,
	describeMissingTurnToolCallRecovery,
	finalizeTurnResultMarkdown,
	maybeCaptureTurnResultMarkdownFromToolCall,
	publishTurnResultMarkdownValue,
	resolveMissingTurnToolCallRecovery,
	validateTurnResultMarkdownValue,
} from "./turn-result-markdown.js";

describe("validateTurnResultMarkdownValue", () => {
	it("accepts raw markdown and normalizes surrounding whitespace and line endings", () => {
		expect(validateTurnResultMarkdownValue("\r\n  ## Result\r\n\r\n- Ship it\r\n ")).toEqual({
			ok: true,
			markdown: "## Result\n\n- Ship it",
		});
	});

	it("rejects non-string values", () => {
		expect(validateTurnResultMarkdownValue({ markdown: "## Result" })).toEqual({
			ok: false,
			code: "markdown_string_required",
			message: "markdown_result requires a string markdown value",
		});
	});

	it("rejects empty or whitespace-only markdown", () => {
		expect(validateTurnResultMarkdownValue("  \n\t ")).toEqual({
			ok: false,
			code: "markdown_required",
			message: "markdown_result requires non-empty markdown",
		});
	});

	it("rejects a single outer fenced markdown block", () => {
		expect(validateTurnResultMarkdownValue("```markdown\n## Result\n\n- Ship it\n```")).toEqual({
			ok: false,
			code: "outer_code_fence_not_allowed",
			message: "Pass raw markdown to markdown_result, not a single outer fenced code block",
		});
		expect(validateTurnResultMarkdownValue("~~~\n## Result\n~~~")).toEqual({
			ok: false,
			code: "outer_code_fence_not_allowed",
			message: "Pass raw markdown to markdown_result, not a single outer fenced code block",
		});
	});

	it("allows markdown that legitimately contains fenced code blocks internally", () => {
		expect(
			validateTurnResultMarkdownValue(
				"## Result\n\nHere is code:\n\n```ts\nconsole.log('hi');\n```\n\nAnd a conclusion.",
			),
		).toEqual({
			ok: true,
			markdown: "## Result\n\nHere is code:\n\n```ts\nconsole.log('hi');\n```\n\nAnd a conclusion.",
		});
	});
});

describe("publishTurnResultMarkdownValue", () => {
	it("records the first published markdown result", () => {
		const published = publishTurnResultMarkdownValue(createTurnResultMarkdownState(), "## Result");
		expect(published.state).toEqual({ markdown: "## Result", publicationCount: 1 });
		expect(published.response).toEqual({
			ok: true,
			code: "markdown_result_recorded",
			message: "Recorded the markdown result for this turn",
			data: {
				publicationCount: 1,
				markdownLength: 9,
			},
		});
	});

	it("keeps the previous value when a publication attempt is invalid", () => {
		const first = publishTurnResultMarkdownValue(createTurnResultMarkdownState(), "## Result");
		const second = publishTurnResultMarkdownValue(first.state, "```markdown\n## Wrong\n```");
		expect(second.state).toEqual(first.state);
		expect(second.response).toEqual({
			ok: false,
			code: "outer_code_fence_not_allowed",
			message: "Pass raw markdown to markdown_result, not a single outer fenced code block",
			data: {},
		});
	});

	it("uses the most recent successful publication when called multiple times", () => {
		const first = publishTurnResultMarkdownValue(createTurnResultMarkdownState(), "## First");
		const second = publishTurnResultMarkdownValue(first.state, "## Second\n\nUpdated.");
		expect(second.state).toEqual({
			markdown: "## Second\n\nUpdated.",
			publicationCount: 2,
		});
		expect(second.response).toEqual({
			ok: true,
			code: "markdown_result_updated",
			message: "Updated the markdown result for this turn",
			data: {
				publicationCount: 2,
				markdownLength: 19,
			},
		});
	});
});

describe("createMarkdownResultTool", () => {
	it("returns validation errors without throwing and preserves the published state", async () => {
		const stateRef = { current: createTurnResultMarkdownState() };
		const tool = createMarkdownResultTool(stateRef);

		expect(await tool.execute({ markdown: "## Result" })).toMatchObject({
			ok: true,
			code: "markdown_result_recorded",
		});
		expect(await tool.execute({ markdown: "```markdown\n## Wrong\n```" })).toMatchObject({
			ok: false,
			code: "outer_code_fence_not_allowed",
		});
		expect(stateRef.current).toEqual({ markdown: "## Result", publicationCount: 1 });
	});
});

describe("maybeCaptureTurnResultMarkdownFromToolCall", () => {
	it("captures markdown from matching non-core tool arguments when requested", () => {
		const stateRef = { current: createTurnResultMarkdownState() };
		maybeCaptureTurnResultMarkdownFromToolCall({
			behavior: {
				mode: "tool_call",
				toolName: "publish_review",
				path: "payload.markdown",
				source: "arguments",
				required: true,
			},
			stateRef,
			toolName: "publish_review",
			args: { payload: { markdown: "## Review\n\n- Ship it" } },
			result: { ok: true },
		});

		expect(stateRef.current).toEqual({
			markdown: "## Review\n\n- Ship it",
			publicationCount: 1,
		});
	});

	it("ignores invalid captured values for non-core tools", () => {
		const stateRef = { current: createTurnResultMarkdownState() };
		maybeCaptureTurnResultMarkdownFromToolCall({
			behavior: {
				mode: "tool_call",
				toolName: "publish_review",
				path: "payload.markdown",
				source: "result",
				required: true,
			},
			stateRef,
			toolName: "publish_review",
			args: {},
			result: { payload: { markdown: "```markdown\n## Wrong\n```" } },
		});
		expect(stateRef.current).toEqual(createTurnResultMarkdownState());
	});
});

describe("buildTurnToolCallPromptSuffix", () => {
	it("returns no suffix when the turn does not require any tool call", () => {
		expect(
			buildTurnToolCallPromptSuffix({
				outcomeToolNames: [],
				requiresMarkdownResultToolCall: false,
			}),
		).toBe("");
	});

	it("documents the generic completion requirements when an outcome tool is required", () => {
		const suffix = buildTurnToolCallPromptSuffix({
			outcomeToolNames: ["done"],
			requiresMarkdownResultToolCall: false,
		});
		expect(suffix).toContain("Keep any normal assistant reply focused");
		expect(suffix).toContain("End the turn by calling the done outcome tool");
		expect(suffix).toContain("treated as a failure");
	});

	it("documents generated outcome-tool markdown arguments", () => {
		const suffix = buildTurnToolCallPromptSuffix({
			outcomeToolNames: ["done"],
			requiresMarkdownResultToolCall: false,
			outcomeToolMarkdownParameterName: "markdown",
		});
		expect(suffix).toContain("markdown argument");
	});

	it("documents the ordering when markdown_result and an outcome tool are both required", () => {
		const suffix = buildTurnToolCallPromptSuffix({
			outcomeToolNames: ["no_issues", "issues_found"],
			requiresMarkdownResultToolCall: true,
		});
		expect(suffix).toContain("Call the markdown_result tool before the final outcome tool");
		expect(suffix).toContain(
			"End the turn by calling exactly one of these outcome tools: no_issues, issues_found.",
		);
	});
});

describe("buildTurnResultMarkdownPromptSuffix", () => {
	it("documents the markdown_result requirements for turns that use the core tool", () => {
		expect(
			buildTurnResultMarkdownPromptSuffix(
				{ mode: "tool_call", toolName: "markdown_result", path: "markdown", required: true },
				{ usesOutcomeTools: true, hasResultImageTool: false },
			),
		).toContain("Call the markdown_result tool");
	});

	it("documents outcome-tool markdown arguments", () => {
		expect(
			buildTurnResultMarkdownPromptSuffix(
				{ mode: "outcome_tool_argument", parameterName: "markdown", required: true },
				{ usesOutcomeTools: true, hasResultImageTool: false },
			),
		).toContain("markdown argument");
	});
});

describe("resolveMissingTurnToolCallRecovery", () => {
	it("detects when both markdown_result and an outcome tool are still missing", () => {
		expect(
			resolveMissingTurnToolCallRecovery({
				selectedOutcome: null,
				outcomeToolNames: ["done"],
				turnResultMarkdownBehavior: {
					mode: "tool_call",
					toolName: "markdown_result",
					path: "markdown",
					required: true,
				},
				turnResultMarkdownState: createTurnResultMarkdownState(),
			}),
		).toEqual({
			failureCode: "missing_required_tool_calls",
			missingToolNames: ["markdown_result", "done"],
			missingOutcomeToolNames: ["done"],
			missingMarkdownResult: true,
			requiresOutcomeToolMarkdown: false,
		});
	});

	it("builds a markdown-focused recovery prompt when only markdown_result is missing", () => {
		const recovery = resolveMissingTurnToolCallRecovery({
			selectedOutcome: { outcome: "done", params: {} },
			outcomeToolNames: ["done"],
			turnResultMarkdownBehavior: {
				mode: "tool_call",
				toolName: "markdown_result",
				path: "markdown",
				required: true,
			},
			turnResultMarkdownState: createTurnResultMarkdownState(),
		});
		expect(recovery).toMatchObject({
			failureCode: "missing_markdown_result",
			missingToolNames: ["markdown_result"],
		});
		if (!recovery) {
			throw new Error("expected missing markdown_result recovery");
		}
		expect(buildMissingTurnToolCallRecoveryPrompt(recovery)).toContain("Call markdown_result now");
		expect(buildMissingTurnToolCallRecoveryPrompt(recovery)).not.toContain("done outcome tool");
		expect(describeMissingTurnToolCallRecovery(recovery)).toContain("markdown_result");
	});

	it("includes the generated markdown argument in outcome-tool recovery prompts", () => {
		const recovery = resolveMissingTurnToolCallRecovery({
			selectedOutcome: null,
			outcomeToolNames: ["done"],
			turnResultMarkdownBehavior: {
				mode: "outcome_tool_argument",
				parameterName: "markdown",
				required: true,
			},
			turnResultMarkdownState: createTurnResultMarkdownState(),
		});
		expect(recovery).toMatchObject({
			failureCode: "missing_outcome_tool",
			missingToolNames: ["done"],
			requiresOutcomeToolMarkdown: true,
			outcomeToolMarkdownParameterName: "markdown",
		});
		if (!recovery) {
			throw new Error("expected missing outcome recovery");
		}
		expect(buildMissingTurnToolCallRecoveryPrompt(recovery)).toContain("markdown argument");
	});
});

describe("finalizeTurnResultMarkdown", () => {
	it("returns the published markdown when available", () => {
		expect(
			finalizeTurnResultMarkdown({
				behavior: { mode: "tool_call", toolName: "markdown_result", path: "markdown" },
				state: { markdown: "## Result", publicationCount: 1 },
			}),
		).toEqual({ markdown: "## Result", errorMessage: null });
	});

	it("returns markdown captured from an outcome tool argument", () => {
		expect(
			finalizeTurnResultMarkdown({
				behavior: { mode: "outcome_tool_argument", parameterName: "markdown", required: true },
				state: { markdown: "## Outcome", publicationCount: 1 },
			}),
		).toEqual({ markdown: "## Outcome", errorMessage: null });
	});

	it("reports a protocol error when a required publication is missing", () => {
		expect(
			finalizeTurnResultMarkdown({
				behavior: {
					mode: "tool_call",
					toolName: "markdown_result",
					path: "markdown",
					required: true,
				},
				state: createTurnResultMarkdownState(),
			}),
		).toEqual({
			markdown: null,
			errorMessage:
				"Turn requires a successful 'markdown_result' tool call to publish turn result markdown",
		});
	});
});
