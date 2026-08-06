import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { type AssistantMessage, retryAssistantCall } from "@earendil-works/pi-ai";
import type {
	AgentSession,
	AgentSessionEvent,
	AgentSessionServices,
	ModelRuntime,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type {
	PiCustomMessageInput,
	PiCustomTool,
	PiEvent,
	PiEventHandler,
	PiEventType,
	PiPromptOptions,
	PiRunDetails,
	PiSessionDiagnostic,
	PiSessionDiagnosticHandler,
	PiTreeEntry,
	PiTreeHandle,
	PiTreeNode,
	PiTurnExecutionResult,
} from "@leitwerk-dev/process-sdk";
import { resolvePiAgentDir } from "@leitwerk-dev/process-sdk/pi-config";
import type { ConfigSnapshot } from "@leitwerk-dev/protocol";
import { parseDurationMs } from "@leitwerk-dev/watcher-utils";
import type { ManagedPiResourceManifest } from "./managed-pi-bootstrap.js";
import {
	assertResultStayedOnExecutionBranch,
	isPiBranchDriftError,
	PiBranchDriftError,
	type PiBranchOperation,
	resolveExecutionAnchorEntryId,
} from "./pi-branch-guard.js";
import { buildLeitwerkResourceLoaderOptions } from "./resource-loader-factory.js";

const LEITWERK_TOOL_BOOTSTRAP_NAME = "__leitwerk_runtime_bootstrap__";

export type {
	PiCustomMessageInput,
	PiCustomTool,
	PiEvent,
	PiEventHandler,
	PiEventType,
	PiPromptOptions,
	PiRunDetails,
	PiSessionDiagnostic,
	PiSessionDiagnosticHandler,
	PiSessionDiagnosticLevel,
	PiTreeEntry,
	PiTreeHandle,
	PiTreeNode,
	PiTurnExecutionResult,
} from "@leitwerk-dev/process-sdk";
export { isPiBranchDriftError, PiBranchDriftError } from "./pi-branch-guard.js";

export interface PiTreeHandleOptions {
	instanceId: string;
	treeFile: string;
	workspaceRoot: string;
	sessionCwd?: string;
	resume: boolean;
	agentDir?: string;
	configSnapshot?: ConfigSnapshot;
	modelProfileId?: string | null;
	piConfig?: {
		systemPrompt?: string;
		appendSystemPrompt?: string;
		availableToolNames: string[];
	};
}

export interface PiManagedBootstrapOptions {
	agentDir: string;
	workspaceRoot: string;
	sessionCwd: string;
	configSnapshot: ConfigSnapshot;
	piConfig: PiTreeHandleOptions["piConfig"];
	manifest: ManagedPiResourceManifest;
	expectedModel: { providerId: string; modelId: string };
}

export interface PiManagedBootstrapResult {
	loadedResourceIds: string[];
	loadedAgentsFiles: Array<{ path: string; sizeBytes: number }>;
	loadedSkillFiles: Array<{ name: string; path: string }>;
	resolvedModel: { providerId: string; modelId: string };
	diagnostics: string[];
}

export interface PiTreeHandleFactory {
	prepareManagedBootstrap(opts: PiManagedBootstrapOptions): Promise<PiManagedBootstrapResult>;
	inspectPrimaryTree(opts: PiTreePlanningOptions): Promise<PiTreePlanningSnapshot>;
	createPrimaryTreeHandle(opts: PiTreeHandleOptions): Promise<PiTreeHandle>;
}

export interface PiTreePlanningOptions {
	treeFile: string;
	sessionCwd: string;
}

export interface PiTreePlanningSnapshot {
	currentLeafId: string | null;
	entries: readonly Pick<PiTreeEntry, "id" | "parentId">[];
}

/** Read persisted tree topology without creating a Pi session or mutating the tree file. */
export async function inspectPiTreeForPlanning(
	input: PiTreePlanningOptions,
): Promise<PiTreePlanningSnapshot> {
	try {
		await access(input.treeFile);
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			(error as { code?: unknown }).code === "ENOENT"
		) {
			return { currentLeafId: null, entries: [] };
		}
		throw error;
	}

	const { SessionManager } = await import("@earendil-works/pi-coding-agent");
	const manager = SessionManager.open(
		input.treeFile,
		path.dirname(input.treeFile),
		input.sessionCwd,
	);
	const entries: Array<Pick<PiTreeEntry, "id" | "parentId">> = [];
	const visit = (nodes: readonly PiTreeNode[]) => {
		for (const node of nodes) {
			entries.push({ id: node.entry.id, parentId: node.entry.parentId });
			visit(node.children);
		}
	};
	visit(manager.getTree() as unknown as readonly PiTreeNode[]);
	return {
		currentLeafId: manager.getLeafId() ?? null,
		entries,
	};
}

interface MutableAgentSessionRuntime {
	_customTools: ToolDefinition[];
	_refreshToolRegistry(options?: {
		activeToolNames?: string[];
		includeAllExtensionTools?: boolean;
	}): void;
}

interface SessionManagerWithCustomMessages {
	appendCustomMessageEntry(
		customType: string,
		content: string,
		display: boolean,
		details?: unknown,
	): string;
}

interface SessionManagerWithCompaction {
	appendCompaction(
		summary: string,
		firstKeptEntryId: string,
		tokensBefore: number,
		details?: unknown,
		fromHook?: boolean,
	): string;
}

interface PiBeforeToolCallContext {
	toolCall: { name: string };
}

interface PiAgentLoopConfig {
	shouldStopAfterTurn?: (...args: unknown[]) => boolean | Promise<boolean>;
	[key: string]: unknown;
}

interface PiCompletedTurnContext {
	message?: {
		content?: unknown;
		stopReason?: unknown;
	};
}

interface MutableAgentRuntimeHooks {
	beforeToolCall?: (context: PiBeforeToolCallContext, signal: unknown) => unknown;
	createLoopConfig?: (loopOptions?: unknown) => PiAgentLoopConfig;
}

function toIsoTimestamp(value: unknown): string {
	if (typeof value === "number" && Number.isFinite(value)) {
		return new Date(value).toISOString();
	}
	if (typeof value === "string" && value.trim() !== "") {
		return value;
	}
	return new Date().toISOString();
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function toToolSchema(parameters: Record<string, unknown>): Record<string, unknown> {
	if (
		isObjectLike(parameters) &&
		parameters.type === "object" &&
		isObjectLike(parameters.properties)
	) {
		return parameters;
	}

	const properties: Record<string, unknown> = {};
	const required: string[] = [];
	for (const [key, spec] of Object.entries(parameters)) {
		if (isObjectLike(spec)) {
			const {
				required: isRequired,
				requiredErrorCode: _requiredErrorCode,
				invalidErrorCode: _invalidErrorCode,
				minItemsErrorCode: _minItemsErrorCode,
				minimumErrorCode: _minimumErrorCode,
				...jsonSchemaSpec
			} = spec;
			properties[key] = { ...jsonSchemaSpec };
			if (isRequired === true) {
				required.push(key);
			}
		} else {
			properties[key] = { type: "string" };
		}
	}

	return {
		type: "object",
		properties,
		required,
		additionalProperties: false,
	};
}

const LEITWERK_TOOL_BOOTSTRAP: ToolDefinition = {
	name: LEITWERK_TOOL_BOOTSTRAP_NAME,
	label: LEITWERK_TOOL_BOOTSTRAP_NAME,
	description: "Internal leitwerk bootstrap tool",
	promptSnippet: `${LEITWERK_TOOL_BOOTSTRAP_NAME}: Internal leitwerk bootstrap tool`,
	parameters: toToolSchema({}) as ToolDefinition["parameters"],
	execute: async () => ({
		content: [{ type: "text", text: "leitwerk bootstrap" }],
		details: { ok: true },
	}),
};

function stringifyToolResult(result: unknown): string {
	if (typeof result === "string") {
		return result;
	}
	if (result === undefined) {
		return "ok";
	}
	try {
		return JSON.stringify(result, null, 2);
	} catch {
		return String(result);
	}
}

export const TERMINAL_ACKNOWLEDGEMENT_INSTRUCTION =
	'Outcome accepted successfully. Do not call any more tools. Reply only with "done".';

function toToolDefinition(
	tool: PiCustomTool,
	terminalAcknowledgement?: TerminalAcknowledgementRuntime | null,
	suspendPromptGuards?: () => () => void,
): ToolDefinition {
	return {
		name: tool.name,
		label: tool.name,
		description: tool.description,
		promptSnippet: `${tool.name}: ${tool.description}`,
		parameters: toToolSchema(tool.parameters) as ToolDefinition["parameters"],
		...(tool.executionMode ? { executionMode: tool.executionMode } : {}),
		execute: async (toolCallId, args, signal) => {
			const acknowledgementState = terminalAcknowledgement?.state();
			const result = await tool.execute(args as Record<string, unknown>, {
				toolCallId,
				signal: signal ?? new AbortController().signal,
				suspendPromptGuards,
			});
			return {
				content: [
					{
						type: "text",
						text:
							terminalAcknowledgement?.onToolExecuted(acknowledgementState) ??
							stringifyToolResult(result),
					},
				],
				details: result,
			};
		},
	};
}

function getMutableSession(session: AgentSession): MutableAgentSessionRuntime {
	const candidate = session as unknown as Partial<MutableAgentSessionRuntime>;
	if (
		!Array.isArray(candidate._customTools) ||
		typeof candidate._refreshToolRegistry !== "function"
	) {
		throw new Error(
			"AgentSession does not expose the _customTools/_refreshToolRegistry hooks required for temporary tools",
		);
	}
	return candidate as MutableAgentSessionRuntime;
}

function toTemporaryToolRegistrationError(error: unknown): Error {
	return new Error(
		"Pi SDK version incompatible: temporary tool registration unavailable",
		error instanceof Error ? { cause: error } : undefined,
	);
}

function validateRequestedActiveTools(
	requestedToolNames: readonly string[],
	availableToolNames: readonly string[],
): void {
	for (const toolName of requestedToolNames) {
		if (!availableToolNames.includes(toolName)) {
			throw new Error(
				`Requested active Pi tool '${toolName}' is not available for this process. Available tools: ${availableToolNames.join(", ")}`,
			);
		}
	}
}

function toPiRunDetails(input: {
	loadedAgentsFiles: Array<{ path: string; content: string }>;
	loadedSkills: Array<{ name: string; path: string }>;
	availableToolNames: string[];
}): PiRunDetails {
	return {
		loadedAgentsFiles: input.loadedAgentsFiles.map((file) => ({
			path: file.path,
			sizeBytes: Buffer.byteLength(file.content, "utf8"),
		})),
		loadedSkills: input.loadedSkills.map((skill) => ({ name: skill.name, path: skill.path })),
		availableToolNames: [...input.availableToolNames],
	};
}

function updateAgentMessagesForCurrentLeaf(session: AgentSession): void {
	const context = session.sessionManager.buildSessionContext();
	session.agent.state.messages = context.messages;
}

function activeTurnId(state: { currentTurnId: string | null; turnSequence: number }): string {
	return state.currentTurnId ?? `turn-${state.turnSequence}`;
}

function readNonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.trim() !== "" ? value : null;
}

function readFiniteNumber(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) {
			return parsed;
		}
	}
	return null;
}

function listRecordKeys(value: Record<string, unknown>): string[] {
	return Object.keys(value).slice(0, 12);
}

function summarizeAgentMessages(messages: unknown): Record<string, unknown> {
	if (!Array.isArray(messages)) {
		return { messageCount: 0 };
	}
	const roles = Array.from(
		new Set(
			messages
				.map((message) => (isObjectLike(message) ? readNonEmptyString(message.role) : null))
				.filter((role): role is string => role !== null),
		),
	).slice(0, 8);
	return {
		messageCount: messages.length,
		...(roles.length > 0 ? { roles } : {}),
	};
}

function readToolCallBlockFromPartial(
	assistantMessageEvent: Record<string, unknown>,
): Record<string, unknown> | null {
	const contentIndex = readFiniteNumber(assistantMessageEvent.contentIndex);
	if (contentIndex === null) {
		return null;
	}
	const partial = isObjectLike(assistantMessageEvent.partial)
		? assistantMessageEvent.partial
		: null;
	const content = Array.isArray(partial?.content) ? partial.content : null;
	const block = content?.[contentIndex];
	return isObjectLike(block) && block.type === "toolCall" ? block : null;
}

function extractAssistantPromptError(entry: PiTreeEntry): Error | null {
	const message = entry.message as
		| Partial<{
				role: string;
				stopReason: string;
				errorMessage: string;
				provider: string;
				model: string;
		  }>
		| undefined;
	if (message?.role !== "assistant" || message.stopReason !== "error") {
		return null;
	}
	const errorMessage =
		readNonEmptyString(message.errorMessage) ?? "Pi assistant turn stopped with error";
	const error = new Error(errorMessage) as Error & {
		provider?: string;
		model?: string;
		stopReason?: string;
	};
	error.stopReason = "error";
	const provider = readNonEmptyString(message.provider);
	const model = readNonEmptyString(message.model);
	if (provider) {
		error.provider = provider;
	}
	if (model) {
		error.model = model;
	}
	return error;
}

function isAssistantEntry(entry: PiTreeEntry): boolean {
	const message = entry.message as Partial<{ role: string }> | undefined;
	return message?.role === "assistant";
}

function extractTextFromMessageContent(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.map((block) => {
			if (!isObjectLike(block) || block.type !== "text") {
				return "";
			}
			return typeof block.text === "string" ? block.text : "";
		})
		.filter((text) => text.trim() !== "")
		.join("\n\n");
}

function extractAssistantMarkdown(entry: PiTreeEntry | undefined): string | null {
	if (!entry || !isAssistantEntry(entry)) {
		return null;
	}
	const text = extractTextFromMessageContent(entry.message?.content).trim();
	return text.length > 0 ? text : null;
}

function findFinalAssistantMarkdown(entries: readonly PiTreeEntry[]): string | null {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const markdown = extractAssistantMarkdown(entries[index]);
		if (markdown) {
			return markdown;
		}
	}
	return null;
}

function findFinalAssistantPromptError(entries: readonly PiTreeEntry[]): Error | null {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (!isAssistantEntry(entry)) {
			continue;
		}
		return extractAssistantPromptError(entry);
	}
	return null;
}

const TERMINAL_ACKNOWLEDGEMENT_CLEANUP_TIMEOUT_MS = 1_000;

type TerminalAcknowledgementRunOutcome = { kind: "completed" } | { kind: "failed"; error: unknown };

class TerminalAcknowledgementRuntime {
	private acknowledgementTurnStarted = false;
	private timeout: ReturnType<typeof setTimeout> | null = null;
	private resolveTimeout!: () => void;
	private readonly timeoutReached = new Promise<void>((resolve) => {
		this.resolveTimeout = resolve;
	});

	constructor(
		private readonly control: NonNullable<PiPromptOptions["terminalAcknowledgement"]>,
		private readonly abort: () => Promise<void>,
		private readonly getLeafEntry: () => PiTreeEntry | undefined,
	) {}

	state(): string {
		return this.control.state();
	}

	onToolExecuted(stateBeforeExecution: string | undefined): string | undefined {
		if (stateBeforeExecution !== "open" || this.control.state() !== "outcome_accepted") {
			return undefined;
		}
		if (this.timeout === null) {
			this.timeout = setTimeout(() => {
				this.control.markFailed(
					`Terminal acknowledgement exceeded ${this.control.timeoutMs}ms and was ignored`,
				);
				this.resolveTimeout();
			}, this.control.timeoutMs);
		}
		return TERMINAL_ACKNOWLEDGEMENT_INSTRUCTION;
	}

	onBeforeToolCall(toolName: string): void {
		if (!this.acknowledgementTurnStarted || this.control.state() !== "outcome_accepted") {
			return;
		}
		this.control.markFailed(
			`Terminal acknowledgement attempted blocked tool '${toolName}' and was ignored`,
		);
		this.clearTimeout();
	}

	onTurnCompleted(args: readonly unknown[]): boolean | null {
		const state = this.control.state();
		if (!this.acknowledgementTurnStarted) {
			if (state !== "outcome_accepted") return null;
			this.acknowledgementTurnStarted = true;
			return false;
		}
		if (state === "outcome_accepted") {
			const context = isObjectLike(args[0]) ? (args[0] as PiCompletedTurnContext) : null;
			this.settleFromMessage(context?.message);
		}
		return true;
	}

	async run(run: () => Promise<void>): Promise<void> {
		const runOutcome = run().then<
			TerminalAcknowledgementRunOutcome,
			TerminalAcknowledgementRunOutcome
		>(
			() => ({ kind: "completed" }),
			(error: unknown) => ({ kind: "failed", error }),
		);
		const firstOutcome = await Promise.race([
			runOutcome,
			this.timeoutReached.then(() => ({ kind: "timeout" }) as const),
		]);
		if (firstOutcome.kind === "timeout") {
			const finalRunOutcome = await this.abortAndAwaitCleanup(runOutcome);
			if (this.control.isOperatorAbortRequested() && finalRunOutcome.kind === "failed") {
				throw finalRunOutcome.error;
			}
			return;
		}
		if (firstOutcome.kind === "completed") {
			this.settleAfterRun();
			return;
		}
		if (!this.canIgnoreRunError()) {
			throw firstOutcome.error;
		}
	}

	dispose(): void {
		this.clearTimeout();
	}

	private settleAfterRun(): void {
		if (
			this.control.state() !== "outcome_accepted" ||
			!this.acknowledgementTurnStarted ||
			this.control.isOperatorAbortRequested()
		) {
			return;
		}
		this.settleFromMessage(this.getLeafEntry()?.message);
	}

	private canIgnoreRunError(): boolean {
		if (this.control.isOperatorAbortRequested()) return false;
		if (!this.acknowledgementTurnStarted || this.control.state() !== "outcome_accepted") {
			return false;
		}
		const leaf = this.getLeafEntry();
		if (!leaf || !extractAssistantPromptError(leaf)) return false;
		this.settleFromMessage(leaf.message);
		return true;
	}

	private async abortAndAwaitCleanup(
		runOutcome: Promise<TerminalAcknowledgementRunOutcome>,
	): Promise<TerminalAcknowledgementRunOutcome> {
		const abortOutcome = this.abort().then(
			() => ({ kind: "completed" }) as const,
			(error: unknown) => ({ kind: "failed", error }) as const,
		);
		let cleanupTimeout: ReturnType<typeof setTimeout> | null = null;
		const cleanupTimedOut = new Promise<true>((resolve) => {
			cleanupTimeout = setTimeout(() => resolve(true), TERMINAL_ACKNOWLEDGEMENT_CLEANUP_TIMEOUT_MS);
		});
		const cleanupOutcome = await Promise.race([
			Promise.all([runOutcome, abortOutcome]).then(([finalRunOutcome, finalAbortOutcome]) => ({
				finalRunOutcome,
				finalAbortOutcome,
			})),
			cleanupTimedOut,
		]);
		if (cleanupTimeout !== null) clearTimeout(cleanupTimeout);
		if (cleanupOutcome === true) {
			throw new Error(
				`Timed-out terminal acknowledgement did not stop within ${TERMINAL_ACKNOWLEDGEMENT_CLEANUP_TIMEOUT_MS}ms`,
			);
		}
		if (cleanupOutcome.finalAbortOutcome.kind === "failed") {
			throw new Error("Failed to abort timed-out terminal acknowledgement", {
				cause: cleanupOutcome.finalAbortOutcome.error,
			});
		}
		return cleanupOutcome.finalRunOutcome;
	}

	private settleFromMessage(messageValue: unknown): void {
		const message = isObjectLike(messageValue) ? messageValue : null;
		const responseText = extractTextFromMessageContent(message?.content).trim();
		const stopReason = readNonEmptyString(message?.stopReason);
		if (responseText !== "" && stopReason !== "error" && stopReason !== "aborted") {
			this.control.markSucceeded();
		} else {
			const reason = readNonEmptyString(message?.errorMessage) ?? stopReason ?? "no assistant text";
			this.control.markFailed(`Terminal acknowledgement failed and was ignored: ${reason}`);
		}
		this.clearTimeout();
	}

	private clearTimeout(): void {
		if (this.timeout === null) return;
		clearTimeout(this.timeout);
		this.timeout = null;
	}
}

function describeRetryStart(input: {
	attempt: number;
	maxAttempts: number;
	delayMs: number;
	errorMessage: string;
}): string {
	const retryLabel =
		input.attempt > 0 && input.maxAttempts > 0
			? `Retry ${input.attempt}/${input.maxAttempts} scheduled`
			: input.attempt > 0
				? `Retry ${input.attempt} scheduled`
				: "Retry scheduled";
	const delayLabel = input.delayMs > 0 ? ` in ${input.delayMs}ms` : "";
	return input.errorMessage
		? `${retryLabel}${delayLabel}: ${input.errorMessage}`
		: `${retryLabel}${delayLabel}`;
}

function describeRetryEnd(input: {
	success: boolean;
	attempt: number;
	finalError: string | null;
}): string {
	const attemptLabel = input.attempt === 1 ? "1 retry" : `${input.attempt} retries`;
	if (input.success) {
		return input.attempt > 0
			? `Retry sequence succeeded after ${attemptLabel}`
			: "Retry sequence succeeded";
	}
	return input.finalError
		? `Retry sequence failed after ${attemptLabel}: ${input.finalError}`
		: `Retry sequence failed after ${attemptLabel}`;
}

export interface AgentSessionEventTranslation {
	piEvents: PiEvent[];
	diagnostics: PiSessionDiagnostic[];
}

const INACTIVITY_RESET_EVENT_TYPES = new Set<PiEventType>([
	"turn.start",
	"stream.delta",
	"tool.call",
	"tool.update",
	"tool.result",
	"toolcall.start",
	"toolcall.delta",
	"toolcall.end",
	"compaction.start",
	"compaction.end",
	"error",
	"retry.start",
	"retry.end",
]);

export function doesPiEventResetInactivity(event: PiEvent): boolean {
	return INACTIVITY_RESET_EVENT_TYPES.has(event.type);
}

function omitType(value: Record<string, unknown>): Record<string, unknown> {
	const { type: _type, ...rest } = value;
	return rest;
}

function normalizePiEventData(value: Record<string, unknown>): Record<string, unknown> {
	const raw = omitType(value);
	const normalized: Record<string, unknown> = {};
	const partialToolCall = readToolCallBlockFromPartial(raw);
	const rawToolCall = isObjectLike(raw.toolCall)
		? raw.toolCall
		: isObjectLike(partialToolCall)
			? partialToolCall
			: null;
	const toolCallId = readNonEmptyString(raw.toolCallId) ?? readNonEmptyString(rawToolCall?.id);
	const name =
		readNonEmptyString(raw.name) ??
		readNonEmptyString(raw.toolName) ??
		readNonEmptyString(rawToolCall?.name);
	if (toolCallId) {
		normalized.toolCallId = toolCallId;
	}
	if (name) {
		normalized.name = name;
	}
	if ("args" in raw && !("arguments" in raw)) {
		normalized.arguments = raw.args;
	} else if ("arguments" in raw) {
		normalized.arguments = raw.arguments;
	} else if (rawToolCall && "arguments" in rawToolCall) {
		normalized.arguments = rawToolCall.arguments;
	}
	if (rawToolCall && "thoughtSignature" in rawToolCall) {
		normalized.thoughtSignature = rawToolCall.thoughtSignature;
	}
	if ("delta" in raw) {
		normalized.delta = raw.delta;
	}
	if ("partialResult" in raw) {
		normalized.partialResult = raw.partialResult;
	}
	if ("result" in raw) {
		normalized.result = raw.result;
	}
	if ("isError" in raw) {
		normalized.isError = raw.isError;
	}
	for (const [key, entryValue] of Object.entries(raw)) {
		if (key === "toolName" || key === "args" || key === "toolCall" || key === "partial") {
			continue;
		}
		if (key in normalized) {
			continue;
		}
		normalized[key] = entryValue;
	}
	return normalized;
}

function readSessionEventTimestamp(event: unknown): string {
	const eventRecord = isObjectLike(event) ? event : {};
	const messageTimestamp = isObjectLike(eventRecord.message)
		? (eventRecord.message as { timestamp?: unknown }).timestamp
		: undefined;
	return toIsoTimestamp(messageTimestamp ?? eventRecord.timestamp);
}

function buildSessionDiagnostic(input: {
	level: PiSessionDiagnostic["level"];
	code: string;
	message: string;
	timestamp: string;
	turnId?: string;
	details?: Record<string, unknown>;
}): PiSessionDiagnostic {
	return {
		level: input.level,
		code: input.code,
		message: input.message,
		timestamp: input.timestamp,
		...(input.turnId ? { turnId: input.turnId } : {}),
		...(input.details ? { details: input.details } : {}),
	};
}

function summarizeSessionGlobalDiagnosticDetails(
	event: AgentSessionEvent,
): Record<string, unknown> {
	const raw = omitType(event as unknown as Record<string, unknown>);
	const base = {
		category: "session_global",
		eventType: event.type,
	};
	if (event.type === "queue_update") {
		return {
			...base,
			steeringCount: Array.isArray(event.steering) ? event.steering.length : 0,
			followUpCount: Array.isArray(event.followUp) ? event.followUp.length : 0,
		};
	}
	if (event.type === "agent_end") {
		return {
			...base,
			...summarizeAgentMessages((event as { messages?: unknown }).messages),
		};
	}
	const keys = listRecordKeys(raw);
	return keys.length > 0 ? { ...base, keys } : base;
}

function buildKnownSessionGlobalDiagnostic(
	event: AgentSessionEvent,
	code: string,
	message: string,
): PiSessionDiagnostic {
	return buildSessionDiagnostic({
		level: "info",
		code,
		message,
		timestamp: readSessionEventTimestamp(event),
		details: summarizeSessionGlobalDiagnosticDetails(event),
	});
}

function buildUnknownSessionEventDiagnostic(
	event: AgentSessionEvent,
	state: { currentTurnId: string | null },
): PiSessionDiagnostic {
	const eventType =
		readNonEmptyString((event as unknown as Record<string, unknown>).type) ?? "unknown";
	const raw = omitType(event as unknown as Record<string, unknown>);
	const keys = listRecordKeys(raw);
	return buildSessionDiagnostic({
		level: "warn",
		code: "pi.session.event_unknown",
		message: `Unhandled Pi session event '${eventType}'`,
		timestamp: readSessionEventTimestamp(event),
		...(state.currentTurnId ? { turnId: state.currentTurnId } : {}),
		details: {
			kind: "session.event.unknown",
			scope: "agent_session_event",
			eventType,
			...(keys.length > 0 ? { keys } : {}),
		},
	});
}

function buildUnknownAssistantEventDiagnostic(input: {
	event: AgentSessionEvent;
	assistantMessageEvent: Record<string, unknown>;
	turnId: string;
	timestamp: string;
}): PiSessionDiagnostic {
	const assistantEventType = readNonEmptyString(input.assistantMessageEvent.type) ?? "unknown";
	const raw = omitType(input.assistantMessageEvent);
	const keys = listRecordKeys(raw);
	const contentIndex = readFiniteNumber(input.assistantMessageEvent.contentIndex);
	return buildSessionDiagnostic({
		level: "warn",
		code: "pi.session.event_unknown",
		message: `Unhandled Pi assistant message_update event '${assistantEventType}'`,
		timestamp: input.timestamp,
		turnId: input.turnId,
		details: {
			kind: "session.event.unknown",
			scope: "assistant_message_event",
			eventType: input.event.type,
			assistantEventType,
			...(contentIndex !== null ? { contentIndex } : {}),
			...(keys.length > 0 ? { keys } : {}),
		},
	});
}

export function translateAgentSessionEventEnvelope(
	event: AgentSessionEvent,
	state: { currentTurnId: string | null; turnSequence: number },
): AgentSessionEventTranslation {
	const runtimeEventType = (event as unknown as { type?: unknown }).type;
	if (runtimeEventType === "session_info_changed") {
		return {
			piEvents: [],
			diagnostics: [
				buildKnownSessionGlobalDiagnostic(
					event,
					"pi.session_info_changed",
					"Pi session info changed",
				),
			],
		};
	}
	switch (event.type) {
		case "turn_start": {
			const rawTurnIndex = (event as { turnIndex?: unknown }).turnIndex;
			const turnIndex =
				typeof rawTurnIndex === "number" && Number.isFinite(rawTurnIndex)
					? rawTurnIndex
					: state.turnSequence + 1;
			state.turnSequence = turnIndex;
			const turnId = `turn-${turnIndex}`;
			state.currentTurnId = turnId;
			return {
				piEvents: [
					{
						type: "turn.start",
						turnId,
						data: {},
						timestamp: toIsoTimestamp((event as { timestamp?: unknown }).timestamp),
					},
				],
				diagnostics: [],
			};
		}
		case "turn_end": {
			const turnId = state.currentTurnId ?? `turn-${state.turnSequence}`;
			state.currentTurnId = null;
			return {
				piEvents: [
					{
						type: "turn.end",
						turnId,
						data: {},
						timestamp: toIsoTimestamp((event.message as { timestamp?: unknown }).timestamp),
					},
				],
				diagnostics: [],
			};
		}
		case "message_start":
			return { piEvents: [], diagnostics: [] };
		case "message_update": {
			const turnId = state.currentTurnId;
			if (!turnId) {
				return { piEvents: [], diagnostics: [] };
			}
			const assistantMessageEvent = event.assistantMessageEvent as unknown as Record<
				string,
				unknown
			>;
			const timestamp = toIsoTimestamp((event.message as { timestamp?: unknown }).timestamp);
			switch (event.assistantMessageEvent.type) {
				case "text_delta":
					return {
						piEvents: [
							{
								type: "stream.delta",
								turnId,
								data: {
									text: event.assistantMessageEvent.delta,
									streamType: "text",
								},
								timestamp,
							},
						],
						diagnostics: [],
					};
				case "thinking_delta":
					return {
						piEvents: [
							{
								type: "stream.delta",
								turnId,
								data: {
									text: event.assistantMessageEvent.delta,
									streamType: "thinking",
								},
								timestamp,
							},
						],
						diagnostics: [],
					};
				case "toolcall_start":
					return {
						piEvents: [
							{
								type: "toolcall.start",
								turnId,
								data: normalizePiEventData(assistantMessageEvent),
								timestamp,
							},
						],
						diagnostics: [],
					};
				case "toolcall_delta":
					return {
						piEvents: [
							{
								type: "toolcall.delta",
								turnId,
								data: normalizePiEventData(assistantMessageEvent),
								timestamp,
							},
						],
						diagnostics: [],
					};
				case "toolcall_end":
					return {
						piEvents: [
							{
								type: "toolcall.end",
								turnId,
								data: normalizePiEventData(assistantMessageEvent),
								timestamp,
							},
						],
						diagnostics: [],
					};
				case "start":
				case "done":
				case "error":
				case "text_start":
				case "text_end":
				case "thinking_start":
				case "thinking_end":
					return { piEvents: [], diagnostics: [] };
				default:
					return {
						piEvents: [],
						diagnostics: [
							buildUnknownAssistantEventDiagnostic({
								event,
								assistantMessageEvent,
								turnId,
								timestamp,
							}),
						],
					};
			}
		}
		case "message_end": {
			const assistantMessage = event.message as Partial<{
				role: string;
				stopReason: string;
				errorMessage: string;
				provider: string;
				model: string;
				timestamp: unknown;
				usage: {
					input: number;
					output: number;
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
				};
			}>;
			const timestamp = toIsoTimestamp(assistantMessage.timestamp);
			const piEvents: PiEvent[] = [];
			if (assistantMessage.role === "assistant" && assistantMessage.usage) {
				const usage = assistantMessage.usage;
				const cacheHitRate =
					usage.cacheRead + usage.input > 0 ? usage.cacheRead / (usage.cacheRead + usage.input) : 0;
				piEvents.push({
					type: "usage",
					turnId: activeTurnId(state),
					data: {
						input: usage.input,
						output: usage.output,
						...(usage.reasoning !== undefined ? { reasoning: usage.reasoning } : {}),
						cacheRead: usage.cacheRead,
						cacheWrite: usage.cacheWrite,
						totalTokens: usage.totalTokens,
						cost: usage.cost,
						cacheHitRate,
					},
					timestamp,
				});
			}
			const errorMessage = readNonEmptyString(assistantMessage.errorMessage);
			if (
				assistantMessage.role === "assistant" &&
				assistantMessage.stopReason === "error" &&
				errorMessage
			) {
				piEvents.push({
					type: "error",
					turnId: activeTurnId(state),
					data: {
						message: errorMessage,
						errorMessage,
						stopReason: assistantMessage.stopReason,
						source: "assistant",
						...(readNonEmptyString(assistantMessage.provider)
							? { provider: assistantMessage.provider }
							: {}),
						...(readNonEmptyString(assistantMessage.model)
							? { model: assistantMessage.model }
							: {}),
					},
					timestamp,
				});
			}
			return { piEvents, diagnostics: [] };
		}
		case "auto_retry_start":
			return {
				piEvents: [
					{
						type: "retry.start",
						turnId: activeTurnId(state),
						data: {
							attempt: event.attempt,
							maxAttempts: event.maxAttempts,
							delayMs: event.delayMs,
							errorMessage: event.errorMessage,
							message: describeRetryStart({
								attempt: event.attempt,
								maxAttempts: event.maxAttempts,
								delayMs: event.delayMs,
								errorMessage: event.errorMessage,
							}),
						},
						timestamp: new Date().toISOString(),
					},
				],
				diagnostics: [],
			};
		case "auto_retry_end": {
			const finalError = readNonEmptyString(event.finalError);
			return {
				piEvents: [
					{
						type: "retry.end",
						turnId: activeTurnId(state),
						data: {
							success: event.success,
							attempt: event.attempt,
							...(finalError ? { finalError } : {}),
							message: describeRetryEnd({
								success: event.success,
								attempt: event.attempt,
								finalError,
							}),
						},
						timestamp: new Date().toISOString(),
					},
				],
				diagnostics: [],
			};
		}
		case "tool_execution_start":
			return {
				piEvents: [
					{
						type: "tool.call",
						turnId: state.currentTurnId ?? `turn-tool-${event.toolCallId}`,
						data: {
							toolCallId: event.toolCallId,
							name: event.toolName,
							arguments: event.args,
						},
						timestamp: new Date().toISOString(),
					},
				],
				diagnostics: [],
			};
		case "tool_execution_update":
			return {
				piEvents: [
					{
						type: "tool.update",
						turnId: state.currentTurnId ?? `turn-tool-${event.toolCallId}`,
						data: normalizePiEventData(event as unknown as Record<string, unknown>),
						timestamp: readSessionEventTimestamp(event),
					},
				],
				diagnostics: [],
			};
		case "tool_execution_end": {
			const turnId = state.currentTurnId ?? `turn-tool-${event.toolCallId}`;
			const timestamp = new Date().toISOString();
			const toolResultEvent: PiEvent = {
				type: "tool.result",
				turnId,
				data: {
					toolCallId: event.toolCallId,
					name: event.toolName,
					result: event.result,
					isError: event.isError,
				},
				timestamp,
			};
			if (!event.isError) {
				return { piEvents: [toolResultEvent], diagnostics: [] };
			}
			return {
				piEvents: [
					toolResultEvent,
					{
						type: "error",
						turnId,
						data: {
							message:
								typeof event.result === "string" ? event.result : stringifyToolResult(event.result),
							errorMessage:
								typeof event.result === "string" ? event.result : stringifyToolResult(event.result),
							toolName: event.toolName,
							source: "tool",
						},
						timestamp,
					},
				],
				diagnostics: [],
			};
		}
		case "compaction_start":
			return {
				piEvents: [
					{
						type: "compaction.start",
						turnId: activeTurnId(state),
						data: normalizePiEventData(event as unknown as Record<string, unknown>),
						timestamp: readSessionEventTimestamp(event),
					},
				],
				diagnostics: [],
			};
		case "compaction_end":
			return {
				piEvents: [
					{
						type: "compaction.end",
						turnId: activeTurnId(state),
						data: normalizePiEventData(event as unknown as Record<string, unknown>),
						timestamp: readSessionEventTimestamp(event),
					},
				],
				diagnostics: [],
			};
		case "agent_start":
			return {
				piEvents: [],
				diagnostics: [
					buildKnownSessionGlobalDiagnostic(event, "pi.agent_start", "Pi agent run started"),
				],
			};
		case "agent_end":
			return {
				piEvents: [],
				diagnostics: [
					buildKnownSessionGlobalDiagnostic(event, "pi.agent_end", "Pi agent run ended"),
				],
			};
		case "agent_settled":
			return {
				piEvents: [],
				diagnostics: [
					buildKnownSessionGlobalDiagnostic(event, "pi.agent_settled", "Pi agent run settled"),
				],
			};
		case "queue_update":
			return {
				piEvents: [],
				diagnostics: [
					buildKnownSessionGlobalDiagnostic(event, "pi.queue_update", "Pi session queue updated"),
				],
			};
		default:
			return {
				piEvents: [],
				diagnostics: [buildUnknownSessionEventDiagnostic(event, state)],
			};
	}
}

export class SdkPiTreeHandle implements PiTreeHandle {
	readonly sessionId: string;
	readonly treeFile: string;
	readonly isResumed: boolean;

	private readonly eventState = { currentTurnId: null as string | null, turnSequence: 0 };
	private readonly eventHandlers = new Set<PiEventHandler>();
	private readonly diagnosticHandlers = new Set<PiSessionDiagnosticHandler>();
	private sessionUnsubscribe: (() => void) | null = null;
	private continuationRetryAbortController: AbortController | null = null;
	private readonly availableToolNames: string[];
	private readonly runDetails: PiRunDetails;

	constructor(
		private readonly session: AgentSession,
		options: {
			treeFile: string;
			isResumed: boolean;
			availableToolNames: string[];
			runDetails: PiRunDetails;
		},
	) {
		this.sessionId = session.sessionId;
		this.treeFile = options.treeFile;
		this.isResumed = options.isResumed;
		this.availableToolNames = [...options.availableToolNames];
		this.runDetails = {
			loadedAgentsFiles: options.runDetails.loadedAgentsFiles.map((file) => ({ ...file })),
			loadedSkills: options.runDetails.loadedSkills.map((skill) => ({ ...skill })),
			availableToolNames: [...options.runDetails.availableToolNames],
		};
	}

	getRunDetails(): PiRunDetails {
		return {
			loadedAgentsFiles: this.runDetails.loadedAgentsFiles.map((file) => ({ ...file })),
			loadedSkills: this.runDetails.loadedSkills.map((skill) => ({ ...skill })),
			availableToolNames: [...this.runDetails.availableToolNames],
		};
	}

	getLeafId(): string | null {
		return this.session.sessionManager.getLeafId();
	}

	getEntry(id: string): PiTreeEntry | undefined {
		return this.session.sessionManager.getEntry(id) as PiTreeEntry | undefined;
	}

	getBranch(fromId?: string): PiTreeEntry[] {
		return this.session.sessionManager.getBranch(fromId) as PiTreeEntry[];
	}

	getChildren(parentId: string): PiTreeEntry[] {
		return this.session.sessionManager.getChildren(parentId) as PiTreeEntry[];
	}

	getTree(): PiTreeNode[] {
		return this.session.sessionManager.getTree() as unknown as PiTreeNode[];
	}

	async branch(entryId: string): Promise<void> {
		this.session.sessionManager.branch(entryId);
		updateAgentMessagesForCurrentLeaf(this.session);
	}

	async branchFromRoot(): Promise<void> {
		this.session.sessionManager.resetLeaf();
		updateAgentMessagesForCurrentLeaf(this.session);
	}

	async resetLeaf(): Promise<void> {
		await this.branchFromRoot();
	}

	async compact(customInstructions?: string, details?: unknown): Promise<unknown> {
		if (details === undefined) {
			const result = await this.session.compact(customInstructions);
			updateAgentMessagesForCurrentLeaf(this.session);
			return result;
		}

		const sessionManager = this.session.sessionManager as unknown as SessionManagerWithCompaction;
		if (typeof sessionManager.appendCompaction !== "function") {
			throw new Error("Pi SDK version incompatible: compaction detail insertion unavailable");
		}

		const appendCompaction = sessionManager.appendCompaction;
		let appendCount = 0;
		sessionManager.appendCompaction = (
			summary,
			firstKeptEntryId,
			tokensBefore,
			_originalDetails,
			fromHook,
		) => {
			appendCount += 1;
			return appendCompaction.call(
				sessionManager,
				summary,
				firstKeptEntryId,
				tokensBefore,
				details,
				fromHook,
			);
		};

		try {
			const result = await this.session.compact(customInstructions);
			if (appendCount !== 1) {
				throw new Error(
					`Pi SDK compaction detail insertion expected one append, received ${appendCount}`,
				);
			}
			updateAgentMessagesForCurrentLeaf(this.session);
			return result;
		} finally {
			sessionManager.appendCompaction = appendCompaction;
		}
	}

	private async withToolConfiguration(
		options: PiPromptOptions,
		run: () => Promise<void>,
	): Promise<void> {
		const customTools = options.tools ?? [];
		const requestedActiveToolNames =
			options.activeTools !== undefined ? [...options.activeTools] : [];
		validateRequestedActiveTools(requestedActiveToolNames, this.availableToolNames);
		const previousActiveToolNames = this.session.getActiveToolNames();
		const needsRuntimeHooks =
			options.shouldBlockToolCall !== undefined || options.terminalAcknowledgement !== undefined;
		if (
			customTools.length === 0 &&
			!needsRuntimeHooks &&
			previousActiveToolNames.length === requestedActiveToolNames.length &&
			previousActiveToolNames.every(
				(toolName, index) => toolName === requestedActiveToolNames[index],
			)
		) {
			return run();
		}

		let mutableSession: MutableAgentSessionRuntime;
		try {
			mutableSession = getMutableSession(this.session);
		} catch (error) {
			throw toTemporaryToolRegistrationError(error);
		}
		const mutableAgent = this.session.agent as unknown as MutableAgentRuntimeHooks;
		const previousCustomTools = [...mutableSession._customTools];
		const previousBeforeToolCall = mutableAgent.beforeToolCall;
		const previousCreateLoopConfig = mutableAgent.createLoopConfig;
		const loopConfigHook = previousCreateLoopConfig;
		if (options.terminalAcknowledgement && typeof loopConfigHook !== "function") {
			throw new Error("Pi SDK version incompatible: agent loop configuration hook unavailable");
		}
		const terminalAcknowledgement = options.terminalAcknowledgement
			? new TerminalAcknowledgementRuntime(
					options.terminalAcknowledgement,
					() => this.abortTurn(),
					() => {
						const leafId = this.getLeafId();
						return leafId ? this.getEntry(leafId) : undefined;
					},
				)
			: null;
		const tempDefinitions = customTools.map((tool) =>
			toToolDefinition(tool, terminalAcknowledgement, options.suspendPromptGuards),
		);
		mutableSession._customTools = [...previousCustomTools, ...tempDefinitions];
		mutableSession._refreshToolRegistry({
			activeToolNames: [
				...new Set([...requestedActiveToolNames, ...tempDefinitions.map((tool) => tool.name)]),
			],
		});
		if (needsRuntimeHooks) {
			mutableAgent.beforeToolCall = async (context, signal) => {
				terminalAcknowledgement?.onBeforeToolCall(context.toolCall.name);
				const blockedReason = options.shouldBlockToolCall?.(context.toolCall.name);
				if (blockedReason) {
					return { block: true, reason: blockedReason };
				}
				return await previousBeforeToolCall?.(context as never, signal);
			};
			if (terminalAcknowledgement && typeof loopConfigHook === "function") {
				mutableAgent.createLoopConfig = (loopOptions?: unknown) => {
					const baseConfig = loopConfigHook.call(mutableAgent, loopOptions);
					const previousShouldStop = baseConfig.shouldStopAfterTurn;
					return {
						...baseConfig,
						shouldStopAfterTurn: async (...args: unknown[]) => {
							const acknowledgementDecision =
								terminalAcknowledgement?.onTurnCompleted(args) ?? null;
							if (acknowledgementDecision !== null) {
								return acknowledgementDecision;
							}
							if (typeof previousShouldStop === "function") {
								return await previousShouldStop(...args);
							}
							return false;
						},
					};
				};
			}
		}

		try {
			if (terminalAcknowledgement) {
				await terminalAcknowledgement.run(run);
			} else {
				await run();
			}
		} finally {
			terminalAcknowledgement?.dispose();
			mutableSession._customTools = previousCustomTools;
			mutableAgent.beforeToolCall = previousBeforeToolCall;
			mutableAgent.createLoopConfig = previousCreateLoopConfig;
			mutableSession._refreshToolRegistry({
				activeToolNames: previousActiveToolNames,
			});
		}
	}

	/**
	 * Pi 0.81 has no public session-level continue API. Mirror its public retry
	 * contract for a retained prompt leaf without calling private session methods.
	 */
	private async runRetryAwareContinuation(): Promise<void> {
		const controller = new AbortController();
		this.continuationRetryAbortController = controller;
		try {
			await retryAssistantCall(
				async () => {
					await this.session.agent.continue();
					const leafId = this.getLeafId();
					const message = leafId ? this.getEntry(leafId)?.message : undefined;
					if (message?.role !== "assistant") {
						throw new Error("Pi continuation completed without an assistant message");
					}
					return message as AssistantMessage;
				},
				this.session.settingsManager.getRetrySettings(),
				controller.signal,
				{
					onRetryScheduled: (attempt, maxAttempts, delayMs, errorMessage) => {
						this.emitSessionEvent({
							type: "auto_retry_start",
							attempt,
							maxAttempts,
							delayMs,
							errorMessage,
						});
						const messages = this.session.agent.state.messages;
						if (messages.at(-1)?.role === "assistant") {
							this.session.agent.state.messages = messages.slice(0, -1);
						}
					},
					onRetryFinished: (success, attempt, finalError) =>
						this.emitSessionEvent({
							type: "auto_retry_end",
							success,
							attempt,
							finalError: controller.signal.aborted ? "Retry cancelled" : finalError,
						}),
				},
			);
			await this.session.waitForIdle();
		} finally {
			if (this.continuationRetryAbortController === controller) {
				this.continuationRetryAbortController = null;
			}
		}
	}

	private createExecutionBranchSnapshot() {
		const startLeafId = this.getLeafId();
		const beforeEntryIds = new Set(
			(this.session.sessionManager.getEntries() as PiTreeEntry[]).map((entry) => entry.id),
		);
		return {
			startLeafId,
			createdEntries: () =>
				(this.session.sessionManager.getEntries() as PiTreeEntry[]).filter(
					(entry) => !beforeEntryIds.has(entry.id),
				),
			assertResult: (
				operation: PiBranchOperation,
				anchorEntryId: string | null,
				resultEntryId: string | null,
			) =>
				assertResultStayedOnExecutionBranch({
					operation,
					startLeafId,
					beforeEntryIds,
					anchorEntryId,
					resultEntryId,
					getBranch: (entryId) => this.getBranch(entryId),
				}),
		};
	}

	private async captureTurnExecutionResult(
		operation: PiBranchOperation,
		run: () => Promise<void>,
		missingLeafMessage: string,
		terminalAcknowledgement?: PiPromptOptions["terminalAcknowledgement"],
	): Promise<PiTurnExecutionResult> {
		const branch = this.createExecutionBranchSnapshot();
		const readVerifiedCreatedEntries = (resultEntryId: string | null): PiTreeEntry[] => {
			const createdEntries = branch.createdEntries();
			branch.assertResult(
				operation,
				resolveExecutionAnchorEntryId({
					operation,
					startLeafId: branch.startLeafId,
					createdEntries,
				}),
				resultEntryId,
			);
			return createdEntries;
		};
		try {
			await run();
		} catch (error) {
			try {
				readVerifiedCreatedEntries(this.getLeafId());
			} catch (driftError) {
				if (isPiBranchDriftError(driftError)) {
					throw driftError;
				}
			}
			throw error;
		}
		const endLeafId = this.getLeafId();
		if (!endLeafId) {
			throw new Error(missingLeafMessage);
		}
		const createdEntries = readVerifiedCreatedEntries(endLeafId);
		const createdEntryIds = createdEntries.map((entry) => entry.id);
		const resultBranchEntryIds = new Set(this.getBranch(endLeafId).map((entry) => entry.id));
		const branchCreatedEntries = createdEntries.filter((entry) =>
			resultBranchEntryIds.has(entry.id),
		);
		const promptError = findFinalAssistantPromptError(branchCreatedEntries);
		if (promptError && terminalAcknowledgement?.state() !== "acknowledgement_failed_ignored") {
			throw promptError;
		}
		return {
			startLeafId: branch.startLeafId,
			endLeafId,
			createdEntryIds,
			resultEntryId: endLeafId,
			assistantMarkdown: findFinalAssistantMarkdown(branchCreatedEntries),
		};
	}

	private async executePrompt(
		options: PiPromptOptions,
		run: () => Promise<void>,
	): Promise<PiTurnExecutionResult> {
		return await this.captureTurnExecutionResult(
			"prompt",
			() => this.withToolConfiguration(options, run),
			"Pi prompt completed without an active leaf",
			options.terminalAcknowledgement,
		);
	}

	async prompt(text: string, options: PiPromptOptions = {}): Promise<PiTurnExecutionResult> {
		return await this.executePrompt(options, () => this.session.prompt(text));
	}

	async promptLiteral(text: string, options: PiPromptOptions = {}): Promise<PiTurnExecutionResult> {
		return await this.executePrompt(options, () => this.session.sendUserMessage(text));
	}

	async promptCustom(
		input: PiCustomMessageInput,
		options: PiPromptOptions = {},
	): Promise<PiTurnExecutionResult> {
		return await this.executePrompt(options, () =>
			this.session.sendCustomMessage(
				{ customType: "leitwerk", ...input, display: input.display ?? false },
				{ triggerTurn: true },
			),
		);
	}

	async continueTurn(options: PiPromptOptions = {}): Promise<PiTurnExecutionResult> {
		updateAgentMessagesForCurrentLeaf(this.session);
		return await this.captureTurnExecutionResult(
			"continue",
			() => this.withToolConfiguration(options, () => this.runRetryAwareContinuation()),
			"Pi continuation completed without an active leaf",
			options.terminalAcknowledgement,
		);
	}

	async appendCustomMessage(input: PiCustomMessageInput): Promise<string> {
		const branch = this.createExecutionBranchSnapshot();
		const sessionManager = this.session
			.sessionManager as unknown as SessionManagerWithCustomMessages;
		if (typeof sessionManager.appendCustomMessageEntry !== "function") {
			throw new Error("Pi SDK version incompatible: custom message insertion unavailable");
		}
		const entryId = sessionManager.appendCustomMessageEntry(
			"leitwerk",
			input.content,
			input.display ?? false,
			input.details,
		);
		updateAgentMessagesForCurrentLeaf(this.session);
		const endLeafId = this.getLeafId();
		if (endLeafId !== entryId) {
			throw new PiBranchDriftError({
				operation: "continue",
				anchorEntryId: entryId,
				rejectedResultEntryId: endLeafId ?? entryId,
			});
		}
		branch.assertResult("continue", entryId, entryId);
		return entryId;
	}

	async steer(text: string): Promise<void> {
		await this.session.steer(text);
	}

	async abortTurn(): Promise<void> {
		this.continuationRetryAbortController?.abort(new Error("Retry cancelled"));
		await this.session.abort();
	}

	subscribe(handler: PiEventHandler): () => void {
		this.eventHandlers.add(handler);
		this.ensureSessionSubscription();
		return () => {
			this.eventHandlers.delete(handler);
			this.releaseSessionSubscriptionIfIdle();
		};
	}

	subscribeDiagnostics(handler: PiSessionDiagnosticHandler): () => void {
		this.diagnosticHandlers.add(handler);
		this.ensureSessionSubscription();
		return () => {
			this.diagnosticHandlers.delete(handler);
			this.releaseSessionSubscriptionIfIdle();
		};
	}

	private ensureSessionSubscription(): void {
		if (this.sessionUnsubscribe) {
			return;
		}
		this.sessionUnsubscribe = this.session.subscribe((event) => this.emitSessionEvent(event));
	}

	private emitSessionEvent(event: AgentSessionEvent): void {
		const translated = translateAgentSessionEventEnvelope(event, this.eventState);
		for (const piEvent of translated.piEvents) this.emitSubscribedEvent(piEvent);
		for (const diagnostic of translated.diagnostics) this.emitSubscribedDiagnostic(diagnostic);
	}

	private releaseSessionSubscriptionIfIdle(): void {
		if (
			!this.sessionUnsubscribe ||
			this.eventHandlers.size > 0 ||
			this.diagnosticHandlers.size > 0
		) {
			return;
		}
		const unsubscribe = this.sessionUnsubscribe;
		this.sessionUnsubscribe = null;
		unsubscribe();
	}

	private emitSubscribedEvent(event: PiEvent): void {
		for (const handler of this.eventHandlers) {
			try {
				handler(event);
			} catch (error) {
				console.warn("Pi event subscriber failed", error);
			}
		}
	}

	private emitSubscribedDiagnostic(diagnostic: PiSessionDiagnostic): void {
		for (const handler of this.diagnosticHandlers) {
			try {
				handler(diagnostic);
			} catch (error) {
				console.warn("Pi diagnostic subscriber failed", error);
			}
		}
	}

	async close(): Promise<void> {
		if (this.sessionUnsubscribe) {
			this.sessionUnsubscribe();
			this.sessionUnsubscribe = null;
		}
		this.eventHandlers.clear();
		this.diagnosticHandlers.clear();
		if (this.session.isStreaming) {
			try {
				await this.session.abort();
			} catch (error) {
				console.warn(`Failed to abort streaming Pi handle '${this.sessionId}' during close`, error);
			}
		}
		this.session.dispose();
	}
}

interface PiRuntimeDiagnosticSummary {
	type?: string;
	message: string;
}

function collectPiRuntimeDiagnostics(services: AgentSessionServices): PiRuntimeDiagnosticSummary[] {
	const extensionLoadDiagnostics = services.resourceLoader
		.getExtensions()
		.errors.map(({ path: extensionPath, error }) => ({
			type: "error",
			message: `Extension '${extensionPath}' failed to load: ${error}`,
		}));
	const resourceDiagnostics = [
		...services.resourceLoader.getSkills().diagnostics,
		...services.resourceLoader.getPrompts().diagnostics,
		...services.resourceLoader.getThemes().diagnostics,
	].map((diagnostic) => ({
		type: diagnostic.type === "error" ? "error" : diagnostic.type,
		message: diagnostic.message,
	}));
	return [...services.diagnostics, ...extensionLoadDiagnostics, ...resourceDiagnostics];
}

function pathIsWithin(root: string, candidate: string): boolean {
	const relative = path.relative(path.resolve(root), path.resolve(candidate));
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function assertLoadedPathAllowed(input: {
	path: string;
	agentDir: string;
	workspaceRoot: string;
	kind: string;
}): void {
	if (pathIsWithin(input.agentDir, input.path)) return;
	const aggregatedAgentsPath = path.join(input.workspaceRoot, "AGENTS.md");
	const aggregatedSkillsRoot = path.join(input.workspaceRoot, ".leitwerk", "skills");
	if (
		path.resolve(input.path) === path.resolve(aggregatedAgentsPath) ||
		pathIsWithin(aggregatedSkillsRoot, input.path)
	) {
		return;
	}
	throw new Error(
		`Pi ${input.kind} loaded outside the managed resource snapshot or approved process workspace inputs: ${input.path}`,
	);
}

function validateManagedLoadedResources(input: {
	services: AgentSessionServices;
	manifest: ManagedPiResourceManifest;
	agentDir: string;
	workspaceRoot: string;
}): string[] {
	const extensions = input.services.resourceLoader.getExtensions().extensions;
	const skills = input.services.resourceLoader.getSkills().skills;
	const prompts = input.services.resourceLoader.getPrompts().prompts;
	const agentsFiles = input.services.resourceLoader.getAgentsFiles().agentsFiles;
	for (const extension of extensions) {
		assertLoadedPathAllowed({
			path: extension.resolvedPath,
			agentDir: input.agentDir,
			workspaceRoot: input.workspaceRoot,
			kind: "extension",
		});
	}
	for (const skill of skills) {
		assertLoadedPathAllowed({
			path: skill.filePath,
			agentDir: input.agentDir,
			workspaceRoot: input.workspaceRoot,
			kind: "skill",
		});
	}
	for (const prompt of prompts) {
		assertLoadedPathAllowed({
			path: prompt.filePath,
			agentDir: input.agentDir,
			workspaceRoot: input.workspaceRoot,
			kind: "prompt",
		});
	}
	for (const agentsFile of agentsFiles) {
		assertLoadedPathAllowed({
			path: agentsFile.path,
			agentDir: input.agentDir,
			workspaceRoot: input.workspaceRoot,
			kind: "context file",
		});
	}

	const loadedResourceIds: string[] = [];
	for (const resource of input.manifest.provenance) {
		const expectedPath = path.resolve(input.agentDir, resource.snapshotPath);
		let loaded = resource.kind === "generated";
		if (resource.kind === "extension") {
			loaded = extensions.some(
				(extension) => path.resolve(extension.resolvedPath) === expectedPath,
			);
		} else if (resource.kind === "skill") {
			loaded = skills.some((skill) => pathIsWithin(skill.baseDir, expectedPath));
		} else if (resource.kind === "prompt") {
			loaded = prompts.some((prompt) => path.resolve(prompt.filePath) === expectedPath);
		}
		if (!loaded) {
			throw new Error(
				`Pi did not load declared ${resource.kind} resource '${resource.snapshotPath}'`,
			);
		}
		loadedResourceIds.push(resource.snapshotPath);
	}
	return loadedResourceIds;
}

async function createManagedAgentSessionServices(input: {
	agentDir: string;
	sessionCwd: string;
	workspaceRoot: string;
	piConfig?: PiTreeHandleOptions["piConfig"];
}): Promise<AgentSessionServices> {
	const { createAgentSessionServices, ModelRuntime, SettingsManager } = await import(
		"@earendil-works/pi-coding-agent"
	);
	const settingsManager = SettingsManager.create(input.sessionCwd, input.agentDir);
	const modelRuntime = await ModelRuntime.create({
		authPath: path.join(input.agentDir, "auth.json"),
		modelsPath: path.join(input.agentDir, "models.json"),
	});
	return createAgentSessionServices({
		cwd: input.sessionCwd,
		agentDir: input.agentDir,
		modelRuntime,
		settingsManager,
		resourceLoaderOptions: await buildLeitwerkResourceLoaderOptions(
			input.workspaceRoot,
			input.agentDir,
			{
				systemPrompt: input.piConfig?.systemPrompt,
				appendSystemPrompt: input.piConfig?.appendSystemPrompt,
			},
		),
	});
}

function formatPiRuntimeDiagnostics(
	diagnostics: readonly PiRuntimeDiagnosticSummary[] | undefined,
): string {
	const messages = (diagnostics ?? [])
		.filter((diagnostic) => diagnostic.type === undefined || diagnostic.type === "error")
		.map((diagnostic) => diagnostic.message.trim())
		.filter((message) => message.length > 0);
	if (messages.length === 0) {
		return "";
	}
	return ` Pi extension diagnostics: ${messages.join("; ")}`;
}

function resolveModelSelection(
	modelProfileId: string | null | undefined,
	configSnapshot: ConfigSnapshot | undefined,
	modelRuntime: ModelRuntime,
	diagnostics?: readonly PiRuntimeDiagnosticSummary[],
): { model?: ReturnType<ModelRuntime["getModel"]>; thinkingLevel?: string } {
	if (!modelProfileId) {
		return {};
	}

	const profile = configSnapshot?.pi.model_profiles.find(
		(candidate) => candidate.id === modelProfileId,
	);
	if (!profile) {
		throw new Error(`Unknown model profile '${modelProfileId}'`);
	}

	const model = modelRuntime.getModel(profile.provider, profile.model_id);
	if (!model) {
		throw new Error(
			`Unable to resolve configured model '${profile.provider}/${profile.model_id}' for profile '${modelProfileId}'.${formatPiRuntimeDiagnostics(diagnostics)}`,
		);
	}

	return {
		model,
		thinkingLevel: profile.thinking_level,
	};
}

function isAlreadyExistsError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "EEXIST"
	);
}

async function ensureSessionFileExists(input: {
	treeFile: string;
	instanceId: string;
	sessionCwd: string;
	sessionVersion: number;
}): Promise<void> {
	await mkdir(path.dirname(input.treeFile), { recursive: true });
	const header = {
		type: "session",
		version: input.sessionVersion,
		id: input.instanceId,
		timestamp: new Date().toISOString(),
		cwd: input.sessionCwd,
	};
	try {
		await writeFile(input.treeFile, `${JSON.stringify(header)}\n`, { flag: "wx" });
	} catch (error) {
		if (isAlreadyExistsError(error)) {
			return;
		}
		throw error;
	}
}

function applyPiRetryOverrides(
	services: AgentSessionServices,
	configSnapshot: ConfigSnapshot | undefined,
): void {
	const piRetryConfig = configSnapshot?.pi.retry;
	const retryOverrides = {
		enabled: piRetryConfig?.enabled ?? true,
		maxRetries: piRetryConfig?.max_retries ?? 3,
		baseDelayMs: parseDurationMs(piRetryConfig?.base_delay ?? "2s", 2_000, {
			allowHours: true,
		}),
		provider: {
			...(piRetryConfig?.provider.timeout
				? {
						timeoutMs: parseDurationMs(piRetryConfig.provider.timeout, 0, {
							allowHours: true,
						}),
					}
				: {}),
			...(piRetryConfig?.provider.max_retries !== null &&
			piRetryConfig?.provider.max_retries !== undefined
				? { maxRetries: piRetryConfig.provider.max_retries }
				: {}),
			maxRetryDelayMs: parseDurationMs(piRetryConfig?.provider.max_retry_delay ?? "60s", 60_000, {
				allowHours: true,
			}),
		},
	};
	services.settingsManager.applyOverrides({ retry: retryOverrides as never });
}

function managedServicesKey(agentDir: string, sessionCwd: string): string {
	return `${path.resolve(agentDir)}\0${path.resolve(sessionCwd)}`;
}

export class SdkPiTreeHandleFactory implements PiTreeHandleFactory {
	private readonly preparedServices = new Map<string, AgentSessionServices>();

	async prepareManagedBootstrap(
		opts: PiManagedBootstrapOptions,
	): Promise<PiManagedBootstrapResult> {
		const services = await createManagedAgentSessionServices({
			agentDir: opts.agentDir,
			sessionCwd: opts.sessionCwd,
			workspaceRoot: opts.workspaceRoot,
			piConfig: opts.piConfig,
		});
		applyPiRetryOverrides(services, opts.configSnapshot);
		const diagnostics = collectPiRuntimeDiagnostics(services);
		const fatalDiagnostics = diagnostics.filter(
			(diagnostic) => diagnostic.type === undefined || diagnostic.type === "error",
		);
		if (fatalDiagnostics.length > 0) {
			throw new Error(
				`Pi managed bootstrap failed.${formatPiRuntimeDiagnostics(fatalDiagnostics)}`,
			);
		}
		const model = services.modelRuntime.getModel(
			opts.expectedModel.providerId,
			opts.expectedModel.modelId,
		);
		if (!model) {
			throw new Error(
				`Unable to resolve managed Pi model '${opts.expectedModel.providerId}/${opts.expectedModel.modelId}'.${formatPiRuntimeDiagnostics(diagnostics)}`,
			);
		}
		const loadedResourceIds = validateManagedLoadedResources({
			services,
			manifest: opts.manifest,
			agentDir: opts.agentDir,
			workspaceRoot: opts.workspaceRoot,
		});
		const runDetails = toPiRunDetails({
			loadedAgentsFiles: services.resourceLoader.getAgentsFiles().agentsFiles,
			loadedSkills: services.resourceLoader.getSkills().skills.map((skill) => ({
				name: skill.name,
				path: skill.filePath,
			})),
			availableToolNames: opts.piConfig?.availableToolNames ?? [],
		});
		this.preparedServices.set(managedServicesKey(opts.agentDir, opts.sessionCwd), services);
		return {
			loadedResourceIds,
			loadedAgentsFiles: runDetails.loadedAgentsFiles,
			loadedSkillFiles: runDetails.loadedSkills,
			resolvedModel: { ...opts.expectedModel },
			diagnostics: diagnostics.map((diagnostic) => diagnostic.message),
		};
	}

	async inspectPrimaryTree(opts: PiTreePlanningOptions): Promise<PiTreePlanningSnapshot> {
		return inspectPiTreeForPlanning(opts);
	}

	async createPrimaryTreeHandle(opts: PiTreeHandleOptions): Promise<PiTreeHandle> {
		const { CURRENT_SESSION_VERSION, createAgentSessionFromServices, SessionManager } =
			await import("@earendil-works/pi-coding-agent");
		const agentDir = resolvePiAgentDir({
			agentDir: opts.agentDir,
			configSnapshot: opts.configSnapshot,
			fallbackDir: opts.workspaceRoot,
		});
		const sessionCwd = opts.sessionCwd ?? opts.workspaceRoot;
		const availableToolNames = opts.piConfig?.availableToolNames ?? [];
		const key = managedServicesKey(agentDir, sessionCwd);
		const preparedServices = this.preparedServices.get(key);
		if (preparedServices) this.preparedServices.delete(key);
		const services =
			preparedServices ??
			(await createManagedAgentSessionServices({
				agentDir,
				sessionCwd,
				workspaceRoot: opts.workspaceRoot,
				piConfig: opts.piConfig,
			}));
		if (!preparedServices) applyPiRetryOverrides(services, opts.configSnapshot);
		await ensureSessionFileExists({
			treeFile: opts.treeFile,
			instanceId: opts.instanceId,
			sessionCwd,
			sessionVersion: CURRENT_SESSION_VERSION,
		});
		const sessionManager = SessionManager.open(
			opts.treeFile,
			path.dirname(opts.treeFile),
			sessionCwd,
		);
		const modelSelection = resolveModelSelection(
			opts.modelProfileId,
			opts.configSnapshot,
			services.modelRuntime,
			collectPiRuntimeDiagnostics(services),
		);
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager,
			...(modelSelection.model ? { model: modelSelection.model } : {}),
			...(modelSelection.thinkingLevel
				? { thinkingLevel: modelSelection.thinkingLevel as never }
				: {}),
			customTools: [LEITWERK_TOOL_BOOTSTRAP],
			noTools: "builtin",
		});
		getMutableSession(session)._refreshToolRegistry({ activeToolNames: [] });
		const runDetails = toPiRunDetails({
			loadedAgentsFiles: services.resourceLoader.getAgentsFiles().agentsFiles,
			loadedSkills: services.resourceLoader.getSkills().skills.map((skill) => ({
				name: skill.name,
				path: skill.filePath,
			})),
			availableToolNames,
		});
		return new SdkPiTreeHandle(session, {
			treeFile: opts.treeFile,
			isResumed: opts.resume,
			availableToolNames,
			runDetails,
		});
	}
}
