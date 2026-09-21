import type {
	TurnAcceptanceState as DomainTurnAcceptanceState,
	ProcessTurnRecordPathType,
	ProcessTurnTerminalLifecycleStatus,
	TurnId,
} from "@leitwerk-dev/domain";
import type { UsageCostSnapshot, UsageTokenCounts } from "@leitwerk-dev/protocol";

/** @internal */
export interface TurnOptions {
	/** @internal */
	reset?: boolean;
}

/** @internal */
export interface TurnResult<T extends string = string> {
	/** @internal */
	outcome: T;
	/** @internal */
	params: Record<string, unknown>;
}

/** @public */
export const PI_BUILT_IN_TOOL_NAMES = [
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
] as const;
/** @public */
export type PiBuiltInToolName = (typeof PI_BUILT_IN_TOOL_NAMES)[number];

/** Tool names owned by the worker runtime rather than an integration extension. @internal */
export const FRAMEWORK_LLM_TOOL_NAMES = [
	"ask_questions",
	"markdown_result",
	"upload_result_images",
] as const;

/** Names integration tools cannot use because Pi or the worker runtime owns them. @internal */
export const RESERVED_INTEGRATION_TOOL_NAMES = [
	...PI_BUILT_IN_TOOL_NAMES,
	...FRAMEWORK_LLM_TOOL_NAMES,
] as const;

/** @public */
export interface ProcessPiConfig {
	/**
	 * System prompt template. Rendered with Mustache against runtime context.
	 * Use {{variableName}} for escaped values and {{{variableName}}} for raw values.
	 * When omitted, Pi's default system prompt is used.
	 */
	/** @internal */
	systemPromptTemplate?: string;
	/**
	 * Additional text appended after the base system prompt/resources. Rendered
	 * with Mustache against runtime context.
	 */
	/** @public */
	appendSystemPromptTemplate?: string;
	/**
	 * Code-defined Pi session working directory template. Rendered with Mustache
	 * against runtime context. When omitted, the process workspace root is used.
	 */
	/** @public */
	sessionCwdTemplate?: string;
}

/** @internal */
export interface ResolvedProcessPiConfig {
	/** @internal */
	systemPrompt?: string;
	/** @internal */
	appendSystemPrompt?: string;
	/** @internal */
	sessionCwd?: string;
	/** @internal */
	availableToolNames: string[];
}

/** @internal */
export type OutcomeToolParameterType = "string" | "number" | "array" | "boolean" | "object";
/** @internal */
export type OutcomeToolArrayItemType = Exclude<OutcomeToolParameterType, "array">;

/** @internal */
export interface OutcomeToolArrayItemSpec {
	/** @internal */
	type: OutcomeToolArrayItemType;
	/** @internal */
	description?: string;
}

/** @public */
export interface OutcomeToolParameterSpec {
	/** @internal */
	type: OutcomeToolParameterType;
	/** @internal */
	description: string;
	/** @internal */
	required?: boolean;
	/** @internal */
	requiredErrorCode?: string;
	/** @internal */
	invalidErrorCode?: string;
	/** @internal */
	minItems?: number;
	/** @internal */
	minItemsErrorCode?: string;
	/** @internal */
	minimum?: number;
	/** @internal */
	minimumErrorCode?: string;
	/** @internal */
	items?: OutcomeToolArrayItemSpec;
	/** @internal */
	enum?: readonly string[];
}

/** @internal */
export interface OutcomeToolSpec {
	/** @internal */
	description: string;
	/** @internal */
	parameters: Record<string, OutcomeToolParameterSpec>;
	/** Product published from this outcome's turn-result markdown, when selected. @internal */
	publishedProduct?: string;
	/** Outcome parameter whose markdown value is captured as the turn result. @internal */
	turnResultMarkdownParameter?: string;
	/** Outcome parameter containing a concise operator-facing summary. @internal */
	resultSummaryParameter?: string;
}

/** @public */
export interface PiTreeEntry {
	/** @internal */
	readonly id: string;
	/** @internal */
	readonly parentId: string | null;
	/** @public */
	readonly type: string;
	/** @internal */
	readonly timestamp: string;
	/** @public */
	readonly message?: {
		/** @internal */
		readonly role?: string;
		/** @public */
		readonly content?: unknown;
	};
	/** Pi custom-message fields. Details are intentionally excluded from model context. @internal */
	readonly customType?: string;
	/** @public */
	readonly content?: unknown;
	/** @internal */
	readonly details?: unknown;
	/** @internal */
	readonly targetId?: string;
	/** @internal */
	readonly label?: string;
}

/** @internal */
export interface PiTreeNode {
	/** @internal */
	readonly entry: PiTreeEntry;
	/** @internal */
	readonly children: readonly PiTreeNode[];
	/** @internal */
	readonly label?: string;
	/** @internal */
	readonly labelTimestamp?: string;
}

/** @public */
export interface PiTurnExecutionResult {
	/** @internal */
	startLeafId: string | null;
	/** @internal */
	endLeafId: string | null;
	/** @internal */
	createdEntryIds: string[];
	/** @internal */
	resultEntryId: string;
	/** Final assistant markdown captured from the Pi assistant message for this turn, when available. @internal */
	assistantMarkdown?: string | null;
}

/** @internal */
export type PiEventType =
	| "turn.start"
	| "turn.end"
	| "stream.delta"
	| "tool.call"
	| "tool.update"
	| "tool.result"
	| "toolcall.start"
	| "toolcall.delta"
	| "toolcall.end"
	| "compaction.start"
	| "compaction.end"
	| "label.changed"
	| "error"
	| "retry.start"
	| "retry.end"
	| "usage";

/** @internal */
export interface PiEvent {
	/** @internal */
	type: PiEventType;
	/** @internal */
	turnId: string;
	/** @internal */
	data: Record<string, unknown>;
	/** @internal */
	timestamp: string;
}

/** @internal */
export type PiEventHandler = (event: PiEvent) => void;

/** @internal */
export type PiSessionDiagnosticLevel = "debug" | "info" | "warn" | "error";

/** @internal */
export interface PiSessionDiagnostic {
	/** @internal */
	level: PiSessionDiagnosticLevel;
	/** @internal */
	code: string;
	/** @internal */
	message: string;
	/** @internal */
	timestamp: string;
	/** @internal */
	turnId?: string;
	/** @internal */
	details?: Record<string, unknown>;
}

/** @internal */
export type PiSessionDiagnosticHandler = (diagnostic: PiSessionDiagnostic) => void;

/** @public */
export interface PiCustomToolExecutionContext {
	/** Pi's identity for this exact invocation; stable across the paused call. @public */
	toolCallId: string;
	/** Aborted when the active turn is stopped or torn down. @public */
	signal: AbortSignal;
	/** Pause model-execution budgets while this custom tool awaits durable operator input. @internal */
	suspendPromptGuards?: () => () => void;
}

/** @public */
export interface PiCustomTool {
	/** @public */
	name: string;
	/** @internal */
	description: string;
	/** @internal */
	parameters: Record<string, unknown>;
	/** @internal */
	executionMode?: "sequential" | "parallel";
	/** @public */
	execute(args: Record<string, unknown>, context?: PiCustomToolExecutionContext): Promise<unknown>;
}

/** @internal */
export interface PiUsageData extends UsageTokenCounts {
	/** @internal */
	cost: UsageCostSnapshot;
	/** @internal */
	cacheHitRate: number;
}

/** @internal */
export interface PiRunDetails {
	/** @internal */
	loadedAgentsFiles: Array<{
		/** @internal */
		path: string;
		/** @internal */
		sizeBytes: number;
	}>;
	/** @internal */
	loadedSkills: Array<{
		/** @internal */
		name: string;
		/** @internal */
		path: string;
	}>;
	/** @internal */
	availableToolNames: string[];
}

/** @internal */
export type ProcessCustomTool = PiCustomTool;

/** @public */
export interface PiCustomMessageInput {
	/** @internal */
	content: string;
	/** @internal */
	details: unknown;
	/** @internal */
	display?: boolean;
}

/** @internal */
export type PiTerminalAcknowledgementState =
	| "open"
	| "outcome_accepted"
	| "acknowledgement_succeeded"
	| "acknowledgement_failed_ignored";

/** @internal */
export interface PiTerminalAcknowledgementControl {
	/** @internal */
	readonly timeoutMs: number;
	/** @internal */
	state(): PiTerminalAcknowledgementState;
	/** @internal */
	isOperatorAbortRequested(): boolean;
	/** @internal */
	markSucceeded(): void;
	/** @internal */
	markFailed(reason: string): void;
}

/** @public */
export interface PiPromptOptions {
	/** @public */
	tools?: readonly PiCustomTool[];
	/** @internal */
	activeTools?: readonly string[];
	/** @internal Runtime-only hook used by the worker Pi adapter before a tool executes. */
	shouldBlockToolCall?: (toolName: string) => string | null;
	/** @internal Guard suspension used by durable interactive tools. */
	suspendPromptGuards?: () => () => void;
	/** @internal Runtime-only terminal outcome acknowledgement state. */
	terminalAcknowledgement?: PiTerminalAcknowledgementControl;
}

/** @public */
export interface PiTreeHandle {
	/** @internal */
	readonly sessionId: string;
	/** @internal */
	readonly treeFile: string;
	/** @internal */
	readonly isResumed: boolean;

	/** @internal */
	getRunDetails(): PiRunDetails;
	/** @internal */
	getLeafId(): string | null;
	/** @internal */
	getEntry(id: string): PiTreeEntry | undefined;
	/** @internal */
	getBranch(fromId?: string): PiTreeEntry[];
	/** @internal */
	getChildren(parentId: string): PiTreeEntry[];
	/** @internal */
	getTree(): PiTreeNode[];
	/** @internal */
	branch(entryId: string): void | Promise<void>;
	/** @internal */
	branchFromRoot(): void | Promise<void>;
	/** @internal */
	resetLeaf(): void | Promise<void>;
	/**
	 * Compact the current Pi context. `details` is persisted with the resulting
	 * compaction entry, but deliberately remains outside model context.
	 */
	/** @internal */
	compact?(customInstructions?: string, details?: unknown): Promise<unknown>;
	/** @public */
	prompt(text: string, options?: PiPromptOptions): Promise<PiTurnExecutionResult>;
	/** @public */
	promptLiteral(text: string, options?: PiPromptOptions): Promise<PiTurnExecutionResult>;
	/** @public */
	promptCustom(
		input: PiCustomMessageInput,
		options?: PiPromptOptions,
	): Promise<PiTurnExecutionResult>;
	/** @public */
	continueTurn(options?: PiPromptOptions): Promise<PiTurnExecutionResult>;
	/** @internal */
	appendCustomMessage?(input: PiCustomMessageInput): Promise<string>;
	/** @internal */
	steer(text: string): Promise<void>;
	/** @internal */
	abortTurn(): Promise<void>;
	/** @internal */
	subscribe(handler: PiEventHandler): () => void;
	/** @internal */
	subscribeDiagnostics?(handler: PiSessionDiagnosticHandler): () => void;
	/** @internal */
	close(): Promise<void>;
}

/** @public */
export const TURN_CONTEXT_MODES = ["full", "compacted", "fresh", "fresh_seeded"] as const;
/** @public */
export type TurnContextMode = (typeof TURN_CONTEXT_MODES)[number];

/** @public */
export const TURN_COMPLETION_MODES = ["turn_end"] as const;
/** @public */
export type TurnCompletionMode = (typeof TURN_COMPLETION_MODES)[number];

/** @public */
export type TurnBranchType = ProcessTurnRecordPathType;

/** @public */
export interface TurnResultMarkdownNoneBehavior {
	/** @internal */
	mode: "none";
}

/** @public */
export interface TurnResultMarkdownAssistantOutputBehavior {
	/** @internal */
	mode: "assistant_output";
	/** @internal */
	required?: boolean;
}

/** @public */
export interface TurnResultMarkdownToolCallBehavior {
	/** @internal */
	mode: "tool_call";
	/** @internal */
	toolName: string;
	/** @internal */
	source?: "arguments" | "result";
	/** @internal */
	path: string;
	/** @internal */
	required?: boolean;
}

/** @public */
export interface TurnResultMarkdownOutcomeToolArgumentBehavior {
	/** @internal */
	mode: "outcome_tool_argument";
	/** @internal */
	parameterName: string;
	/** @internal */
	required?: boolean;
}

/** @public */
export type TurnResultMarkdownBehavior =
	| TurnResultMarkdownNoneBehavior
	| TurnResultMarkdownAssistantOutputBehavior
	| TurnResultMarkdownToolCallBehavior
	| TurnResultMarkdownOutcomeToolArgumentBehavior;

/** @public */
export type TurnAcceptanceState = DomainTurnAcceptanceState;

/** @public */
export interface ProcessActionSchedulingFixedTurnPreview {
	/** @public */
	kind: "fixed_turn";
	/** @public */
	turnId: TurnId | null;
}

/** @public */
export interface ProcessActionSchedulingTriggerPreview {
	/** @public */
	kind: "trigger";
	/** @internal */
	trigger: string;
}

/** @public */
export interface ProcessActionSchedulingTerminalPreview {
	/** @public */
	kind: "terminal";
	/** @internal */
	lifecycleStatus: ProcessTurnTerminalLifecycleStatus;
}

/** @public */
export type ProcessActionSchedulingPreview =
	| ProcessActionSchedulingFixedTurnPreview
	| ProcessActionSchedulingTriggerPreview
	| ProcessActionSchedulingTerminalPreview;

/** @public */
export type ProcessActionPreviewDefinition = ProcessActionSchedulingPreview;

/** @internal */
export interface ProcessActionSchedulingDefinition {
	/** @internal */
	preview: ProcessActionSchedulingPreview;
}

/** @internal */
export interface HumanTurnActionView {
	/** @internal */
	actionId: string;
	/** @internal */
	acceptanceState: TurnAcceptanceState;
	/** @internal */
	label?: string;
	/** @internal */
	description?: string;
	/** @internal */
	preview?: ProcessActionPreviewDefinition;
	/** @internal */
	scheduling?: ProcessActionSchedulingDefinition;
}

/** @internal */
export interface HumanTurnNotesField {
	/** @internal */
	id: string;
	/** @internal */
	label: string;
	/** @internal */
	description?: string;
	/** @internal */
	placeholder?: string;
	/** @internal */
	required?: boolean;
}

/** @internal */
export interface HumanTurnExternalTrigger {
	/** @internal */
	id: string;
	/** @internal */
	actionId: string;
	/** @internal */
	label: string;
	/** @internal */
	description: string;
}

/** @internal */
export interface HumanTurnExternalActionView {
	/** Process-local arming id exposed to providers and UI. @internal */
	id: string;
	/** @internal */
	externalActionId: string;
	/** @internal */
	sourceKind: string;
	/** @internal */
	label: string | null;
	/** @internal */
	description: string | null;
}

/** @internal */
export interface EventBus<TEventMap extends object = Record<string, unknown>> {
	/** @internal */
	emit<K extends keyof TEventMap & string>(event: K, data: TEventMap[K]): void;
	/** @internal */
	on<K extends keyof TEventMap & string>(
		event: K,
		handler: (data: TEventMap[K]) => void | Promise<void>,
	): void;
	/** @internal */
	off<K extends keyof TEventMap & string>(
		event: K,
		handler: (data: TEventMap[K]) => void | Promise<void>,
	): void;
}
