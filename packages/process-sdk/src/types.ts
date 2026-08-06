import type {
	ProcessSemanticEntryRefKey as DomainProcessSemanticEntryRefKey,
	TurnAcceptanceState as DomainTurnAcceptanceState,
	ProcessInstance,
	ProcessProject,
	ProcessTurnRecordPathType,
	ProcessTurnTerminalLifecycleStatus,
	TurnId,
} from "@leitwerk-dev/domain";

export interface ProcessContext {
	readonly process: ProcessInstance;
	readonly selectedTurnId: TurnId | null;
	readonly isTerminal: boolean;
	readonly projects: readonly ProcessProject[];
	selectTurn(turnId: TurnId | null): void;
}

export interface TurnOptions {
	reset?: boolean;
}

export interface TurnResult<T extends string = string> {
	outcome: T;
	params: Record<string, unknown>;
}

export const PI_BUILT_IN_TOOL_NAMES = [
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
] as const;
export type PiBuiltInToolName = (typeof PI_BUILT_IN_TOOL_NAMES)[number];

export interface ProcessPiConfig {
	/**
	 * System prompt template. Rendered with Mustache against runtime context.
	 * Use {{variableName}} for escaped values and {{{variableName}}} for raw values.
	 * When omitted, Pi's default system prompt is used.
	 */
	systemPromptTemplate?: string;
	/**
	 * Additional text appended after the base system prompt/resources. Rendered
	 * with Mustache against runtime context.
	 */
	appendSystemPromptTemplate?: string;
	/**
	 * Code-defined Pi session working directory template. Rendered with Mustache
	 * against runtime context. When omitted, the process workspace root is used.
	 */
	sessionCwdTemplate?: string;
}

export interface ResolvedProcessPiConfig {
	systemPrompt?: string;
	appendSystemPrompt?: string;
	sessionCwd?: string;
	availableToolNames: string[];
}

export type OutcomeToolParameterType = "string" | "number" | "array" | "boolean" | "object";
export type OutcomeToolArrayItemType = Exclude<OutcomeToolParameterType, "array">;

export interface OutcomeToolArrayItemSpec {
	type: OutcomeToolArrayItemType;
	description?: string;
}

export interface OutcomeToolParameterSpec {
	type: OutcomeToolParameterType;
	description: string;
	required?: boolean;
	requiredErrorCode?: string;
	invalidErrorCode?: string;
	minItems?: number;
	minItemsErrorCode?: string;
	minimum?: number;
	minimumErrorCode?: string;
	items?: OutcomeToolArrayItemSpec;
	enum?: readonly string[];
}

export interface OutcomeToolSpec {
	description: string;
	parameters: Record<string, OutcomeToolParameterSpec>;
	/** Product published from this outcome's turn-result markdown, when selected. */
	publishedProduct?: string;
	/** Outcome parameter whose markdown value is captured as the turn result. */
	turnResultMarkdownParameter?: string;
}

export interface ProcessToolResult {
	status: string;
	outcome?: string;
}

export interface PiTreeEntry {
	readonly id: string;
	readonly parentId: string | null;
	readonly type: string;
	readonly timestamp: string;
	readonly message?: {
		readonly role?: string;
		readonly content?: unknown;
	};
	/** Pi custom-message fields. Details are intentionally excluded from model context. */
	readonly customType?: string;
	readonly content?: unknown;
	readonly details?: unknown;
	readonly targetId?: string;
	readonly label?: string;
}

export interface PiTreeNode {
	readonly entry: PiTreeEntry;
	readonly children: readonly PiTreeNode[];
	readonly label?: string;
	readonly labelTimestamp?: string;
}

export interface PiTurnExecutionResult {
	startLeafId: string | null;
	endLeafId: string | null;
	createdEntryIds: string[];
	resultEntryId: string;
	/** Final assistant markdown captured from the Pi assistant message for this turn, when available. */
	assistantMarkdown?: string | null;
}

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

export interface PiEvent {
	type: PiEventType;
	turnId: string;
	data: Record<string, unknown>;
	timestamp: string;
}

export type PiEventHandler = (event: PiEvent) => void;

export type PiSessionDiagnosticLevel = "debug" | "info" | "warn" | "error";

export interface PiSessionDiagnostic {
	level: PiSessionDiagnosticLevel;
	code: string;
	message: string;
	timestamp: string;
	turnId?: string;
	details?: Record<string, unknown>;
}

export type PiSessionDiagnosticHandler = (diagnostic: PiSessionDiagnostic) => void;

export interface PiCustomToolExecutionContext {
	/** Pi's identity for this exact invocation; stable across the paused call. */
	toolCallId: string;
	/** Aborted when the active turn is stopped or torn down. */
	signal: AbortSignal;
	/** Pause model-execution budgets while this custom tool awaits durable operator input. */
	suspendPromptGuards?: () => () => void;
}

export interface PiCustomTool {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	executionMode?: "sequential" | "parallel";
	execute(args: Record<string, unknown>, context?: PiCustomToolExecutionContext): Promise<unknown>;
}

export interface PiUsageData {
	input: number;
	output: number;
	/** Provider-reported reasoning/thinking tokens. This is a subset of output tokens. */
	reasoning?: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cacheHitRate: number;
}

export interface PiRunDetails {
	loadedAgentsFiles: Array<{ path: string; sizeBytes: number }>;
	loadedSkills: Array<{ name: string; path: string }>;
	availableToolNames: string[];
}

export type ProcessCustomTool = PiCustomTool;

export interface PiCustomMessageInput {
	content: string;
	details: unknown;
	display?: boolean;
}

export type PiTerminalAcknowledgementState =
	| "open"
	| "outcome_accepted"
	| "acknowledgement_succeeded"
	| "acknowledgement_failed_ignored";

export interface PiTerminalAcknowledgementControl {
	readonly timeoutMs: number;
	state(): PiTerminalAcknowledgementState;
	isOperatorAbortRequested(): boolean;
	markSucceeded(): void;
	markFailed(reason: string): void;
}

export interface PiPromptOptions {
	tools?: readonly PiCustomTool[];
	activeTools?: readonly string[];
	/** @internal Runtime-only hook used by the worker Pi adapter before a tool executes. */
	shouldBlockToolCall?: (toolName: string) => string | null;
	/** @internal Guard suspension used by durable interactive tools. */
	suspendPromptGuards?: () => () => void;
	/** @internal Runtime-only terminal outcome acknowledgement state. */
	terminalAcknowledgement?: PiTerminalAcknowledgementControl;
}

export interface PiTreeHandle {
	readonly sessionId: string;
	readonly treeFile: string;
	readonly isResumed: boolean;

	getRunDetails(): PiRunDetails;
	getLeafId(): string | null;
	getEntry(id: string): PiTreeEntry | undefined;
	getBranch(fromId?: string): PiTreeEntry[];
	getChildren(parentId: string): PiTreeEntry[];
	getTree(): PiTreeNode[];
	branch(entryId: string): void | Promise<void>;
	branchFromRoot(): void | Promise<void>;
	resetLeaf(): void | Promise<void>;
	/**
	 * Compact the current Pi context. `details` is persisted with the resulting
	 * compaction entry, but deliberately remains outside model context.
	 */
	compact?(customInstructions?: string, details?: unknown): Promise<unknown>;
	prompt(text: string, options?: PiPromptOptions): Promise<PiTurnExecutionResult>;
	promptLiteral(text: string, options?: PiPromptOptions): Promise<PiTurnExecutionResult>;
	promptCustom(
		input: PiCustomMessageInput,
		options?: PiPromptOptions,
	): Promise<PiTurnExecutionResult>;
	continueTurn(options?: PiPromptOptions): Promise<PiTurnExecutionResult>;
	appendCustomMessage?(input: PiCustomMessageInput): Promise<string>;
	steer(text: string): Promise<void>;
	abortTurn(): Promise<void>;
	subscribe(handler: PiEventHandler): () => void;
	subscribeDiagnostics?(handler: PiSessionDiagnosticHandler): () => void;
	close(): Promise<void>;
}

export const TURN_CONTEXT_MODES = ["full", "compacted", "fresh", "fresh_seeded"] as const;
export type TurnContextMode = (typeof TURN_CONTEXT_MODES)[number];

export const TURN_COMPLETION_MODES = ["turn_end"] as const;
export type TurnCompletionMode = (typeof TURN_COMPLETION_MODES)[number];

export type TurnBranchType = ProcessTurnRecordPathType;
export type TurnSemanticEntryRefKey = DomainProcessSemanticEntryRefKey;

export interface TurnResultMarkdownNoneBehavior {
	mode: "none";
}

export interface TurnResultMarkdownAssistantOutputBehavior {
	mode: "assistant_output";
	required?: boolean;
}

export interface TurnResultMarkdownToolCallBehavior {
	mode: "tool_call";
	toolName: string;
	source?: "arguments" | "result";
	path: string;
	required?: boolean;
}

export interface TurnResultMarkdownOutcomeToolArgumentBehavior {
	mode: "outcome_tool_argument";
	parameterName: string;
	required?: boolean;
}

export type TurnResultMarkdownBehavior =
	| TurnResultMarkdownNoneBehavior
	| TurnResultMarkdownAssistantOutputBehavior
	| TurnResultMarkdownToolCallBehavior
	| TurnResultMarkdownOutcomeToolArgumentBehavior;

export type TurnAcceptanceState = DomainTurnAcceptanceState;

export interface ProcessActionSchedulingFixedTurnPreview {
	kind: "fixed_turn";
	turnId: TurnId | null;
}

export interface ProcessActionSchedulingTriggerPreview {
	kind: "trigger";
	trigger: string;
}

export interface ProcessActionSchedulingTerminalPreview {
	kind: "terminal";
	lifecycleStatus: ProcessTurnTerminalLifecycleStatus;
}

export type ProcessActionSchedulingPreview =
	| ProcessActionSchedulingFixedTurnPreview
	| ProcessActionSchedulingTriggerPreview
	| ProcessActionSchedulingTerminalPreview;

export type ProcessActionPreviewDefinition = ProcessActionSchedulingPreview;

export interface ProcessActionSchedulingDefinition {
	preview: ProcessActionSchedulingPreview;
}

export interface HumanTurnActionView {
	actionId: string;
	acceptanceState: TurnAcceptanceState;
	label?: string;
	description?: string;
	preview?: ProcessActionPreviewDefinition;
	scheduling?: ProcessActionSchedulingDefinition;
}

export interface HumanTurnNotesField {
	id: string;
	label: string;
	description?: string;
	placeholder?: string;
	required?: boolean;
}

export interface HumanTurnExternalTrigger {
	id: string;
	actionId: string;
	label: string;
	description: string;
}

export interface HumanTurnExternalActionView {
	/** Process-local arming id exposed to providers and UI. */
	id: string;
	externalActionId: string;
	sourceKind: string;
	label: string | null;
	description: string | null;
}

export interface EventBus<TEventMap extends object = Record<string, unknown>> {
	emit<K extends keyof TEventMap & string>(event: K, data: TEventMap[K]): void;
	on<K extends keyof TEventMap & string>(
		event: K,
		handler: (data: TEventMap[K]) => void | Promise<void>,
	): void;
	off<K extends keyof TEventMap & string>(
		event: K,
		handler: (data: TEventMap[K]) => void | Promise<void>,
	): void;
}
