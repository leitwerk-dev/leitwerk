import type { FailedTurnRecoveryCode } from "@leitwerk-dev/domain";
import {
	MARKDOWN_RESULT_TOOL_NAME,
	type PiCustomTool,
	type TurnResultMarkdownBehavior,
} from "@leitwerk-dev/process-sdk";
import { readValueAtPath } from "@leitwerk-dev/protocol";

export interface TurnResultMarkdownState {
	markdown: string | null;
	publicationCount: number;
}

export interface TurnResultMarkdownToolResponse {
	ok: boolean;
	code: string;
	message: string;
	data: Record<string, unknown>;
}

export interface MissingTurnToolCallRecovery {
	failureCode: FailedTurnRecoveryCode;
	missingToolNames: string[];
	missingOutcomeToolNames: string[];
	missingMarkdownResult: boolean;
	requiresOutcomeToolMarkdown: boolean;
	outcomeToolMarkdownParameterName?: string;
}

function isWrappedInSingleOuterFence(value: string): boolean {
	const trimmed = value.trim();
	const openingFence = /^(?<fence>`{3,}|~{3,})(?<info>[^\n]*)\n/.exec(trimmed);
	if (!openingFence?.groups?.fence) {
		return false;
	}
	return trimmed.endsWith(`\n${openingFence.groups.fence}`);
}

export function validateTurnResultMarkdownValue(
	value: unknown,
): { ok: true; markdown: string } | { ok: false; code: string; message: string } {
	if (typeof value !== "string") {
		return {
			ok: false,
			code: "markdown_string_required",
			message: "markdown_result requires a string markdown value",
		};
	}
	const markdown = value.replace(/\r\n?/g, "\n").trim();
	if (markdown === "") {
		return {
			ok: false,
			code: "markdown_required",
			message: "markdown_result requires non-empty markdown",
		};
	}
	if (isWrappedInSingleOuterFence(markdown)) {
		return {
			ok: false,
			code: "outer_code_fence_not_allowed",
			message: "Pass raw markdown to markdown_result, not a single outer fenced code block",
		};
	}
	return { ok: true, markdown };
}

export function createTurnResultMarkdownState(): TurnResultMarkdownState {
	return {
		markdown: null,
		publicationCount: 0,
	};
}

export function publishTurnResultMarkdownValue(
	state: TurnResultMarkdownState,
	value: unknown,
): {
	state: TurnResultMarkdownState;
	response: TurnResultMarkdownToolResponse;
} {
	const validation = validateTurnResultMarkdownValue(value);
	if (!validation.ok) {
		return {
			state,
			response: {
				ok: false,
				code: validation.code,
				message: validation.message,
				data: {},
			},
		};
	}
	const nextState: TurnResultMarkdownState = {
		markdown: validation.markdown,
		publicationCount: state.publicationCount + 1,
	};
	return {
		state: nextState,
		response: {
			ok: true,
			code: state.publicationCount === 0 ? "markdown_result_recorded" : "markdown_result_updated",
			message:
				state.publicationCount === 0
					? "Recorded the markdown result for this turn"
					: "Updated the markdown result for this turn",
			data: {
				publicationCount: nextState.publicationCount,
				markdownLength: validation.markdown.length,
			},
		},
	};
}

export function createMarkdownResultTool(stateRef: {
	current: TurnResultMarkdownState;
}): PiCustomTool {
	return {
		name: MARKDOWN_RESULT_TOOL_NAME,
		description:
			"Publish the operator-facing markdown result for this turn. Pass raw markdown only and do not wrap the entire markdown in triple backticks.",
		parameters: {
			markdown: {
				type: "string",
				description:
					"Raw markdown content to render for this turn. Do not wrap the entire markdown in triple backticks.",
			},
		},
		execute: async (args: Record<string, unknown>) => {
			const published = publishTurnResultMarkdownValue(stateRef.current, args.markdown);
			stateRef.current = published.state;
			return published.response;
		},
	};
}

export function buildTurnToolCallPromptSuffix(options: {
	outcomeToolNames: readonly string[];
	requiresMarkdownResultToolCall: boolean;
	outcomeToolMarkdownParameterName?: string;
}): string {
	const outcomeToolNames = options.outcomeToolNames.filter((name) => name.trim().length > 0);
	if (
		!options.requiresMarkdownResultToolCall &&
		!options.outcomeToolMarkdownParameterName &&
		outcomeToolNames.length === 0
	) {
		return "";
	}
	const lines = [
		"Tool completion requirements:",
		"- Keep any normal assistant reply focused and include required result markdown when applicable.",
		"- Do not end with plain text only; finish the turn by calling the required tool(s).",
	];
	if (options.requiresMarkdownResultToolCall) {
		lines.push(
			outcomeToolNames.length > 0
				? "- Call the markdown_result tool before the final outcome tool."
				: "- End the turn by calling the markdown_result tool.",
		);
	}
	if (outcomeToolNames.length === 1) {
		lines.push(`- End the turn by calling the ${outcomeToolNames[0]} outcome tool.`);
	} else if (outcomeToolNames.length > 1) {
		lines.push(
			`- End the turn by calling exactly one of these outcome tools: ${outcomeToolNames.join(", ")}.`,
		);
	}
	if (options.outcomeToolMarkdownParameterName && outcomeToolNames.length > 0) {
		lines.push(
			`- Include the operator-facing markdown result in the ${options.outcomeToolMarkdownParameterName} argument of the outcome tool you call.`,
		);
	}
	lines.push("- A turn that ends without the required tool call is treated as a failure.");
	return `\n\n${lines.join("\n")}`;
}

export function buildTurnResultMarkdownPromptSuffix(
	behavior: TurnResultMarkdownBehavior | undefined,
	options: { usesOutcomeTools: boolean; hasResultImageTool: boolean },
): string {
	const imageGuidance = options.hasResultImageTool
		? "\n- Use upload_result_images for intended screenshots or visual goldens before the terminal outcome."
		: "";
	const visualGuidance = `${imageGuidance}\n- Mermaid diagrams need no upload: include their source in a fenced mermaid block when a diagram materially clarifies the result.`;
	if (behavior?.mode === "assistant_output") {
		const outcomeInstruction = options.usesOutcomeTools
			? "\n- After writing the markdown, call the appropriate outcome tool to finish the turn."
			: "";
		return `\n\nResult publication requirements:\n- Write the operator-facing markdown result as your normal assistant response for this turn.\n- Do not call markdown_result; the leitwerk captures your assistant output automatically.${visualGuidance}${outcomeInstruction}`;
	}
	if (behavior?.mode === "outcome_tool_argument") {
		return `\n\nResult publication requirements:\n- Include the operator-facing markdown result in the ${behavior.parameterName} argument of the outcome tool you call to finish this turn.\n- Do not call markdown_result; the leitwerk captures the outcome tool's ${behavior.parameterName} argument automatically.${visualGuidance}`;
	}
	if (behavior?.mode !== "tool_call" || behavior.toolName !== MARKDOWN_RESULT_TOOL_NAME) {
		return "";
	}
	const requirementPrefix = behavior.required
		? "Before finishing the turn, you must publish the operator-facing markdown result."
		: "If you want operator-facing markdown rendered for this turn, publish it before finishing.";
	const outcomeInstruction = options.usesOutcomeTools
		? "\n- After the markdown_result tool call succeeds, call the appropriate outcome tool to finish the turn."
		: "";
	return `\n\nResult publication requirements:\n- ${requirementPrefix}\n- Call the markdown_result tool with the raw markdown you want the operator UI to render.\n- Do not wrap the entire markdown in triple backticks.\n- If you revise the markdown, call markdown_result again. The most recent successful call is used.${visualGuidance}${outcomeInstruction}`;
}

export function maybeCaptureTurnResultMarkdownFromToolCall(input: {
	behavior: TurnResultMarkdownBehavior | undefined;
	stateRef: { current: TurnResultMarkdownState };
	toolName: string;
	args: Record<string, unknown>;
	result: unknown;
}): void {
	const { behavior, stateRef, toolName, args, result } = input;
	if (!behavior || behavior.mode !== "tool_call" || behavior.toolName !== toolName) {
		return;
	}
	if (toolName === MARKDOWN_RESULT_TOOL_NAME) {
		return;
	}
	const sourceValue = behavior.source === "result" ? result : args;
	const candidate = readValueAtPath(sourceValue, behavior.path);
	const published = publishTurnResultMarkdownValue(stateRef.current, candidate);
	if (published.response.ok) {
		stateRef.current = published.state;
	}
}

export function resolveMissingTurnToolCallRecovery(input: {
	selectedOutcome: { outcome: string; params: Record<string, unknown> } | null;
	outcomeToolNames: readonly string[];
	turnResultMarkdownBehavior: TurnResultMarkdownBehavior | undefined;
	turnResultMarkdownState: TurnResultMarkdownState;
}): MissingTurnToolCallRecovery | null {
	const missingOutcomeToolNames =
		input.selectedOutcome === null
			? [...new Set(input.outcomeToolNames.filter((name) => name.trim() !== ""))]
			: [];
	const missingMarkdownResult =
		input.turnResultMarkdownBehavior?.mode === "tool_call" &&
		input.turnResultMarkdownBehavior.toolName === MARKDOWN_RESULT_TOOL_NAME &&
		input.turnResultMarkdownBehavior.required === true &&
		!input.turnResultMarkdownState.markdown;
	const outcomeToolMarkdownParameterName =
		input.turnResultMarkdownBehavior?.mode === "outcome_tool_argument"
			? input.turnResultMarkdownBehavior.parameterName
			: undefined;
	if (!missingMarkdownResult && missingOutcomeToolNames.length === 0) {
		return null;
	}
	return {
		failureCode:
			missingMarkdownResult && missingOutcomeToolNames.length > 0
				? "missing_required_tool_calls"
				: missingMarkdownResult
					? "missing_markdown_result"
					: "missing_outcome_tool",
		missingToolNames: [
			...(missingMarkdownResult ? [MARKDOWN_RESULT_TOOL_NAME] : []),
			...missingOutcomeToolNames,
		],
		missingOutcomeToolNames,
		missingMarkdownResult,
		requiresOutcomeToolMarkdown: Boolean(outcomeToolMarkdownParameterName),
		...(outcomeToolMarkdownParameterName ? { outcomeToolMarkdownParameterName } : {}),
	};
}

export function buildMissingTurnToolCallRecoveryPrompt(
	recovery: MissingTurnToolCallRecovery,
): string {
	const lines = [
		"Your previous reply did not finish this turn because it missed required tool calls.",
		"Continue from your previous work without starting over.",
	];
	if (recovery.missingMarkdownResult && recovery.missingOutcomeToolNames.length > 0) {
		lines.push(
			"Call markdown_result now with the operator-facing markdown for this turn, then call the required outcome tool to finish.",
		);
	} else if (recovery.missingMarkdownResult) {
		lines.push("Call markdown_result now with the operator-facing markdown for this turn.");
	}
	if (recovery.missingOutcomeToolNames.length === 1) {
		lines.push(
			`Call the ${recovery.missingOutcomeToolNames[0]} outcome tool now to finish the turn.`,
		);
	} else if (recovery.missingOutcomeToolNames.length > 1) {
		lines.push(
			`Call exactly one of these outcome tools now: ${recovery.missingOutcomeToolNames.join(", ")}.`,
		);
	}
	if (recovery.requiresOutcomeToolMarkdown && recovery.outcomeToolMarkdownParameterName) {
		lines.push(
			`Include the operator-facing markdown result in the ${recovery.outcomeToolMarkdownParameterName} argument of that outcome tool.`,
		);
	}
	lines.push("Do not end with plain text only.");
	return lines.join("\n");
}

export function describeMissingTurnToolCallRecovery(recovery: MissingTurnToolCallRecovery): string {
	if (recovery.missingMarkdownResult && recovery.missingOutcomeToolNames.length > 0) {
		return `missing required tool calls (${MARKDOWN_RESULT_TOOL_NAME} and one outcome tool: ${recovery.missingOutcomeToolNames.join(", ")})`;
	}
	if (recovery.missingMarkdownResult) {
		return `missing required '${MARKDOWN_RESULT_TOOL_NAME}' tool call`;
	}
	if (recovery.missingOutcomeToolNames.length === 1) {
		return `missing required '${recovery.missingOutcomeToolNames[0]}' outcome tool call`;
	}
	return `missing required outcome tool call (choose one of: ${recovery.missingOutcomeToolNames.join(", ")})`;
}

export function finalizeTurnResultMarkdown(input: {
	behavior: TurnResultMarkdownBehavior | undefined;
	state: TurnResultMarkdownState;
	assistantMarkdown?: string | null;
}): { markdown: string | null; errorMessage: string | null } {
	if (!input.behavior || input.behavior.mode === "none") {
		return { markdown: input.state.markdown ?? null, errorMessage: null };
	}
	if (input.behavior.mode === "assistant_output") {
		const markdown =
			typeof input.assistantMarkdown === "string" ? input.assistantMarkdown.trim() : "";
		if (markdown.length > 0) {
			return { markdown, errorMessage: null };
		}
		return input.behavior.required
			? {
					markdown: null,
					errorMessage: "Turn requires non-empty assistant output to publish turn result markdown",
				}
			: { markdown: null, errorMessage: null };
	}
	if (input.behavior.mode === "outcome_tool_argument") {
		if (input.state.markdown) {
			return { markdown: input.state.markdown, errorMessage: null };
		}
		return input.behavior.required
			? {
					markdown: null,
					errorMessage: `Turn requires a successful outcome tool call with a non-empty '${input.behavior.parameterName}' markdown argument`,
				}
			: { markdown: null, errorMessage: null };
	}
	if (input.state.markdown) {
		return { markdown: input.state.markdown, errorMessage: null };
	}
	if (input.behavior.required) {
		return {
			markdown: null,
			errorMessage: `Turn requires a successful '${input.behavior.toolName}' tool call to publish turn result markdown`,
		};
	}
	return { markdown: null, errorMessage: null };
}
