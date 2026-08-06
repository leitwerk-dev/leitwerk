import type { FailedTurnRecoveryContext } from "@leitwerk-dev/domain";
import type {
	LlmTurnDefinition,
	OutcomeToolSpec,
	PiCustomTool,
	PiTerminalAcknowledgementControl,
} from "@leitwerk-dev/process-sdk";
import { resolveTurnActiveToolNames } from "@leitwerk-dev/process-sdk/pi-config";
import {
	ASK_QUESTIONS_PROMPT_GUIDANCE,
	createAskQuestionsTool,
	type WorkerQuestionRequest,
} from "./question-tool.js";
import {
	buildMissingTurnToolCallRecoveryPrompt,
	buildTurnResultMarkdownPromptSuffix,
	buildTurnToolCallPromptSuffix,
	createMarkdownResultTool,
	createTurnResultMarkdownState,
	describeMissingTurnToolCallRecovery,
	finalizeTurnResultMarkdown,
	type MissingTurnToolCallRecovery,
	maybeCaptureTurnResultMarkdownFromToolCall,
	publishTurnResultMarkdownValue,
	resolveMissingTurnToolCallRecovery,
	type TurnResultMarkdownState,
} from "./turn-result-markdown.js";

export type TurnOutcomeSelection<TOutcome extends string> = {
	outcome: TOutcome;
	params: Record<string, unknown>;
};

export const TERMINAL_ACKNOWLEDGEMENT_TIMEOUT_MS = 30_000;

export type TerminalAcknowledgementState =
	| { kind: "open" }
	| { kind: "outcome_accepted" }
	| { kind: "acknowledgement_succeeded" }
	| { kind: "acknowledgement_failed_ignored"; reason: string };

export type ToolCompletionSnapshot<TOutcome extends string> = {
	selectedOutcome: TurnOutcomeSelection<TOutcome> | null;
	markdownState: TurnResultMarkdownState;
};

export interface TurnOutcomeToolSession<TOutcome extends string> {
	readonly outcomeToolNames: string[];
	readonly usesOutcomeTools: boolean;
	readonly requiresMarkdownResultToolCall: boolean;
	readonly tools: PiCustomTool[];
	readonly activeTools: readonly string[];
	addPromptSuffix(promptText: string): string;
	reset(baseState?: ToolCompletionSnapshot<TOutcome>): void;
	getCompletionState(): ToolCompletionSnapshot<TOutcome>;
	readonly terminalAcknowledgement: Pick<
		PiTerminalAcknowledgementControl,
		"state" | "markSucceeded" | "markFailed"
	> & { failureReason(): string | null };
	shouldBlockToolCall(toolName: string): string | null;
	resolveOutcome(
		turnDef: LlmTurnDefinition<TOutcome, unknown, unknown>,
	): TurnOutcomeSelection<TOutcome> | null;
	resolveMissingToolRecovery(
		completionState: ToolCompletionSnapshot<TOutcome>,
	): MissingTurnToolCallRecovery | null;
	buildRecoveryContext(recovery: MissingTurnToolCallRecovery): FailedTurnRecoveryContext;
	describeRecovery(recovery: MissingTurnToolCallRecovery): string;
	finalizeMarkdown(
		completionState: ToolCompletionSnapshot<TOutcome>,
		assistantMarkdown?: string | null,
	): ReturnType<typeof finalizeTurnResultMarkdown>;
}

function cloneSelectedOutcome<TOutcome extends string>(
	value: TurnOutcomeSelection<TOutcome> | null,
): TurnOutcomeSelection<TOutcome> | null {
	return value ? { outcome: value.outcome, params: { ...value.params } } : null;
}

function cloneTurnResultMarkdownState(state: TurnResultMarkdownState): TurnResultMarkdownState {
	return {
		markdown: state.markdown,
		publicationCount: state.publicationCount,
	};
}

function snapshotToolCompletionState<TOutcome extends string>(
	value: ToolCompletionSnapshot<TOutcome>,
): ToolCompletionSnapshot<TOutcome> {
	return {
		selectedOutcome: cloneSelectedOutcome(value.selectedOutcome),
		markdownState: cloneTurnResultMarkdownState(value.markdownState),
	};
}

export function createTurnOutcomeToolSession<TOutcome extends string>(input: {
	turnId: string;
	turnRecordId?: string;
	turnDef: LlmTurnDefinition<TOutcome, unknown, unknown>;
	resultImageTool?: PiCustomTool | null;
	requestQuestions?: (request: WorkerQuestionRequest) => Promise<string[]>;
}): TurnOutcomeToolSession<TOutcome> {
	let selectedOutcome: TurnOutcomeSelection<TOutcome> | null = null;
	let terminalAcknowledgement: TerminalAcknowledgementState = { kind: "open" };
	const turnResultMarkdownStateRef = { current: createTurnResultMarkdownState() };
	const outcomeToolEntries = Object.entries(input.turnDef.outcomes ?? {}) as [
		string,
		OutcomeToolSpec,
	][];
	const outcomeToolNames = outcomeToolEntries.map(([outcome]) => outcome);
	const usesOutcomeTools = outcomeToolEntries.length > 0;
	const requiresMarkdownResultToolCall =
		input.turnDef.turnResultMarkdown?.mode === "tool_call" &&
		input.turnDef.turnResultMarkdown.toolName === "markdown_result" &&
		input.turnDef.turnResultMarkdown.required === true;
	const hasResultImageTool = Boolean(
		input.turnDef.turnResultMarkdown &&
			input.turnDef.turnResultMarkdown.mode !== "none" &&
			input.resultImageTool,
	);
	const outcomeToolMarkdownParameterName =
		input.turnDef.turnResultMarkdown?.mode === "outcome_tool_argument"
			? input.turnDef.turnResultMarkdown.parameterName
			: undefined;
	const outcomeActions = outcomeToolEntries.map(([outcome, spec]) => {
		const markdownParameterName =
			spec.turnResultMarkdownParameter ?? outcomeToolMarkdownParameterName;
		const injectsGlobalMarkdownParameter =
			Boolean(outcomeToolMarkdownParameterName) && !spec.turnResultMarkdownParameter;
		return {
			name: outcome,
			description: spec.description,
			parameters: {
				...Object.fromEntries(Object.entries(spec.parameters).map(([key, value]) => [key, value])),
				...(injectsGlobalMarkdownParameter && outcomeToolMarkdownParameterName
					? {
							[outcomeToolMarkdownParameterName]: {
								type: "string",
								description:
									"Operator-facing markdown result for this turn. Pass raw markdown only and do not wrap the entire markdown in triple backticks.",
								required: true,
								requiredErrorCode: `${outcomeToolMarkdownParameterName}_required`,
							},
						}
					: {}),
			},
			executionMode: "sequential" as const,
			execute: async (args: Record<string, unknown>) => {
				const result = { status: "ok", outcome };
				const acceptsOutcome = selectedOutcome === null;
				if (acceptsOutcome) {
					let outcomeParams = args;
					if (markdownParameterName) {
						const published = publishTurnResultMarkdownValue(
							turnResultMarkdownStateRef.current,
							args[markdownParameterName],
						);
						if (!published.response.ok) {
							return published.response;
						}
						turnResultMarkdownStateRef.current = published.state;
						if (injectsGlobalMarkdownParameter) {
							outcomeParams = { ...args };
							delete outcomeParams[markdownParameterName];
						}
					}
					selectedOutcome = { outcome: outcome as TOutcome, params: outcomeParams };
				}
				maybeCaptureTurnResultMarkdownFromToolCall({
					behavior: input.turnDef.turnResultMarkdown,
					stateRef: turnResultMarkdownStateRef,
					toolName: outcome,
					args,
					result,
				});
				if (acceptsOutcome) {
					terminalAcknowledgement = { kind: "outcome_accepted" };
				}
				return result;
			},
		};
	});
	const questionTool =
		input.turnDef.askQuestions && input.turnRecordId && input.requestQuestions
			? createAskQuestionsTool({
					turnRecordId: input.turnRecordId,
					request: input.requestQuestions,
				})
			: null;
	const tools = [
		...(hasResultImageTool && input.resultImageTool ? [input.resultImageTool] : []),
		...(input.turnDef.turnResultMarkdown?.mode === "tool_call" &&
		input.turnDef.turnResultMarkdown.toolName === "markdown_result"
			? [createMarkdownResultTool(turnResultMarkdownStateRef)]
			: []),
		...outcomeActions,
		...(questionTool ? [questionTool] : []),
	];
	const activeTools = resolveTurnActiveToolNames({
		turnId: input.turnId,
		turnDef: input.turnDef as LlmTurnDefinition<string, unknown, unknown>,
	});

	const terminalAcknowledgementControl = {
		state: () => terminalAcknowledgement.kind,
		markSucceeded() {
			if (terminalAcknowledgement.kind === "outcome_accepted") {
				terminalAcknowledgement = { kind: "acknowledgement_succeeded" };
			}
		},
		markFailed(reason: string) {
			if (terminalAcknowledgement.kind === "outcome_accepted") {
				terminalAcknowledgement = { kind: "acknowledgement_failed_ignored", reason };
			}
		},
		failureReason: () =>
			terminalAcknowledgement.kind === "acknowledgement_failed_ignored"
				? terminalAcknowledgement.reason
				: null,
	} satisfies TurnOutcomeToolSession<TOutcome>["terminalAcknowledgement"];

	return {
		outcomeToolNames,
		usesOutcomeTools,
		requiresMarkdownResultToolCall,
		tools,
		activeTools,
		terminalAcknowledgement: terminalAcknowledgementControl,
		addPromptSuffix(promptText) {
			let next = promptText;
			if (questionTool) next += ASK_QUESTIONS_PROMPT_GUIDANCE;
			next += buildTurnToolCallPromptSuffix({
				outcomeToolNames,
				requiresMarkdownResultToolCall,
				outcomeToolMarkdownParameterName,
			});
			next += buildTurnResultMarkdownPromptSuffix(input.turnDef.turnResultMarkdown, {
				usesOutcomeTools,
				hasResultImageTool,
			});
			return next;
		},
		reset(baseState) {
			selectedOutcome = cloneSelectedOutcome(baseState?.selectedOutcome ?? null);
			terminalAcknowledgement =
				selectedOutcome === null ? { kind: "open" } : { kind: "acknowledgement_succeeded" };
			turnResultMarkdownStateRef.current = cloneTurnResultMarkdownState(
				baseState?.markdownState ?? createTurnResultMarkdownState(),
			);
		},
		getCompletionState() {
			return snapshotToolCompletionState({
				selectedOutcome,
				markdownState: turnResultMarkdownStateRef.current,
			});
		},
		shouldBlockToolCall(toolName) {
			if (selectedOutcome === null) {
				return null;
			}
			if (
				requiresMarkdownResultToolCall &&
				turnResultMarkdownStateRef.current.publicationCount === 0 &&
				toolName === "markdown_result"
			) {
				return null;
			}
			return `Tool '${toolName}' was skipped because an outcome has already been accepted for this turn.`;
		},
		resolveOutcome(turnDef) {
			if (usesOutcomeTools) {
				return selectedOutcome;
			}
			return turnDef.turnEnd
				? {
						outcome: turnDef.turnEnd.outcome,
						params: turnDef.turnEnd.params ?? {},
					}
				: null;
		},
		resolveMissingToolRecovery(completionState) {
			return resolveMissingTurnToolCallRecovery({
				selectedOutcome: completionState.selectedOutcome,
				outcomeToolNames,
				turnResultMarkdownBehavior: input.turnDef.turnResultMarkdown,
				turnResultMarkdownState: completionState.markdownState,
			});
		},
		buildRecoveryContext(recovery) {
			return {
				strategy: "continue",
				suggestedContinuePrompt: buildMissingTurnToolCallRecoveryPrompt(recovery),
				failureCode: recovery.failureCode,
				...(recovery.missingToolNames.length > 0
					? { missingToolNames: recovery.missingToolNames }
					: {}),
			};
		},
		describeRecovery(recovery) {
			return describeMissingTurnToolCallRecovery(recovery);
		},
		finalizeMarkdown(completionState, assistantMarkdown) {
			return finalizeTurnResultMarkdown({
				behavior: input.turnDef.turnResultMarkdown,
				state: completionState.markdownState,
				assistantMarkdown,
			});
		},
	};
}
