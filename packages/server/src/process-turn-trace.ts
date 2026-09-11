import { type ProcessEvent, type ProcessTurnRecord, trimToNull } from "@leitwerk-dev/domain";
import {
	asWsEventPayloadRecord,
	buildLiveTurnProjectionFromEvents,
	buildPrimaryPathOperationalTraceItem,
	compareTimestampStrings,
	createTurnContinuationIndex,
	extractPiSessionMessageText,
	isPiSessionMessageEntryWithRecord,
	isToolResultTruncated,
	mergeUsageSnapshots,
	normalizeUsageSnapshot,
	type PiSessionContentBlock,
	type PiSessionEntry,
	type PiSessionMessageRecord,
	PRIMARY_PATH_OPERATIONAL_PI_EVENT_TYPES,
	type PrimaryPathOperationalTraceItemSnapshot,
	type PrimaryPathStreamingAssistantSnapshot,
	type PrimaryPathTraceItemSnapshot,
	reasoningPreviewTail,
	snapshotTurnTrace,
	type TurnPiInputPart,
	type TurnPiInputSnapshot,
	type TurnTracePreview,
	type TurnTraceSnapshot,
	type TurnTraceToolCallSnapshot,
	truncateTextPreview,
} from "@leitwerk-dev/protocol";
import type { ReadonlyPiSessionTree } from "./pi-session-tree.js";

const MULTI_PART_PI_INPUT_SEPARATOR =
	"\n\n--- UI-added separator between Pi input messages ---\n\n";
const PREVIEW_MAX_LENGTH = 520;
const OPERATIONAL_PI_EVENT_TYPE_SET = new Set<string>(PRIMARY_PATH_OPERATIONAL_PI_EVENT_TYPES);

function buildTurnPiInputSnapshot(parts: readonly TurnPiInputPart[]): TurnPiInputSnapshot | null {
	const firstPart = parts[0];
	if (!firstPart) {
		return null;
	}
	return {
		parts: [...parts],
		fullPrompt: parts.map((part) => part.text).join(MULTI_PART_PI_INPUT_SEPARATOR),
		createdAt: firstPart.createdAt,
		userInput: null,
	};
}

function isContentBlock(value: unknown): value is PiSessionContentBlock {
	return typeof value === "object" && value !== null && !Array.isArray(value) && "type" in value;
}

function normalizeContentBlocks(content: unknown): PiSessionContentBlock[] {
	if (typeof content === "string") {
		return [{ type: "text", text: content }];
	}
	if (!Array.isArray(content)) {
		return [];
	}
	return content.filter(isContentBlock);
}

function asUnknownRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function normalizeToolArguments(value: unknown): Record<string, unknown> | null {
	const record = asUnknownRecord(value);
	return record ? { ...record } : null;
}

function extractToolResultValue(message: PiSessionMessageRecord): unknown {
	if ("details" in message && message.details !== undefined) {
		return message.details;
	}
	const text = extractPiSessionMessageText(message.content).trim();
	if (text !== "") {
		return text;
	}
	return message.content ?? null;
}

function readNonBlankString(value: unknown): string | null {
	return typeof value === "string" && value.trim() !== "" ? value : null;
}

type TraceTurnRecord = Pick<
	ProcessTurnRecord,
	"id" | "turnType" | "forkPiEntryId" | "resultPiEntryId" | "startedAt" | "endedAt" | "status"
>;

function indexEventsByTurnRecordId(
	events: readonly ProcessEvent[] = [],
): Map<string, ProcessEvent[]> {
	const index = new Map<string, ProcessEvent[]>();
	for (const event of events) {
		const turnRecordId = eventTurnRecordId(event);
		if (turnRecordId) {
			const turnEvents = index.get(turnRecordId) ?? [];
			turnEvents.push(event);
			index.set(turnRecordId, turnEvents);
		}
	}
	return index;
}

function appendOperationalTraceItem(
	traceItems: PrimaryPathTraceItemSnapshot[],
	item: PrimaryPathOperationalTraceItemSnapshot | null,
): void {
	if (!item) {
		return;
	}
	if (
		traceItems.some(
			(existing) =>
				existing.kind === "operational_event" &&
				existing.eventType === item.eventType &&
				existing.message === item.message &&
				existing.timestamp === item.timestamp,
		)
	) {
		return;
	}
	traceItems.push(item);
}

function buildAssistantErrorTraceItem(
	entry: PiSessionEntry,
	message: PiSessionMessageRecord,
): PrimaryPathOperationalTraceItemSnapshot | null {
	if (message.role !== "assistant" || message.stopReason !== "error") {
		return null;
	}
	const errorMessage = readNonBlankString(message.errorMessage);
	if (!errorMessage) {
		return null;
	}
	return buildPrimaryPathOperationalTraceItem({
		eventType: "pi.error",
		data: asWsEventPayloadRecord({
			message: errorMessage,
			errorMessage,
			provider: readNonBlankString(message.provider),
			model: readNonBlankString(message.model),
			timestamp: entry.timestamp,
		}),
		fallbackTimestamp: entry.timestamp,
	});
}

function buildCompactionEntryTraceItem(
	entry: PiSessionEntry,
): PrimaryPathOperationalTraceItemSnapshot | null {
	if (entry.type !== "compaction") {
		return null;
	}
	const record = asUnknownRecord(entry);
	const summary = typeof record?.summary === "string" ? record.summary.trim() : "";
	return {
		kind: "operational_event",
		eventType: "pi.compaction.end",
		severity: "success",
		title: "Context compacted",
		message: summary ? `Pi compacted context. Summary:\n${summary}` : "Pi compacted context.",
		timestamp: entry.timestamp,
	};
}

function buildOperationalEventTraceItem(
	event: ProcessEvent,
): PrimaryPathOperationalTraceItemSnapshot | null {
	if (!OPERATIONAL_PI_EVENT_TYPE_SET.has(event.eventType)) {
		return null;
	}
	return buildPrimaryPathOperationalTraceItem({
		eventType: event.eventType,
		data: asWsEventPayloadRecord(event.data),
		fallbackTimestamp: event.createdAt,
	});
}

function eventTurnRecordId(event: ProcessEvent): string | null {
	return readNonBlankString(event.data.turnRecordId);
}

function compareOperationalTraceItems(
	left: PrimaryPathOperationalTraceItemSnapshot,
	right: PrimaryPathOperationalTraceItemSnapshot,
): number {
	return (
		compareTimestampStrings(left.timestamp, right.timestamp) ||
		left.eventType.localeCompare(right.eventType) ||
		left.message.localeCompare(right.message)
	);
}

function ensureSortedTraceItems(
	traceItems: PrimaryPathTraceItemSnapshot[],
): PrimaryPathTraceItemSnapshot[] {
	const operationalTraceItems = traceItems
		.filter(
			(traceItem): traceItem is PrimaryPathOperationalTraceItemSnapshot =>
				traceItem.kind === "operational_event",
		)
		.sort(compareOperationalTraceItems);
	let nextOperationalIndex = 0;
	return traceItems.map((traceItem) => {
		if (traceItem.kind !== "operational_event") {
			return traceItem;
		}
		const nextOperationalTraceItem = operationalTraceItems[nextOperationalIndex];
		nextOperationalIndex += 1;
		return nextOperationalTraceItem ?? traceItem;
	});
}

function buildTurnTraceFromSlice(input: {
	turnRecordId: string;
	turnSlice: readonly PiSessionEntry[];
	events?: readonly ProcessEvent[];
}): TurnTraceSnapshot | undefined {
	const { turnSlice } = input;

	const promptParts: TurnPiInputPart[] = [];
	const assistant: PrimaryPathStreamingAssistantSnapshot = {
		text: "",
		thinking: "",
		lastUpdatedAt: null,
	};
	const toolCalls: TurnTraceToolCallSnapshot[] = [];
	const toolCallsById = new Map<string, TurnTraceToolCallSnapshot>();
	const traceItems: PrimaryPathTraceItemSnapshot[] = [];
	let usage: TurnTraceSnapshot["usage"] = null;

	const ensureToolCall = (toolInput: {
		toolCallId: string;
		toolName: string;
		startedAt: string;
		arguments: Record<string, unknown> | null;
	}): TurnTraceToolCallSnapshot => {
		const existing = toolCallsById.get(toolInput.toolCallId);
		if (existing) {
			if (!existing.arguments && toolInput.arguments) {
				existing.arguments = toolInput.arguments;
			}
			return existing;
		}
		const toolCall: TurnTraceToolCallSnapshot = {
			toolCallId: toolInput.toolCallId,
			toolName: toolInput.toolName,
			status: "running",
			startedAt: toolInput.startedAt,
			completedAt: null,
			arguments: toolInput.arguments,
			isError: false,
			resultText: null,
			truncated: false,
		};
		toolCalls.push(toolCall);
		toolCallsById.set(toolInput.toolCallId, toolCall);
		traceItems.push({ kind: "tool_call", toolCallId: toolInput.toolCallId });
		return toolCall;
	};

	for (const entry of turnSlice) {
		if (!isPiSessionMessageEntryWithRecord(entry)) {
			appendOperationalTraceItem(traceItems, buildCompactionEntryTraceItem(entry));
			continue;
		}
		const message = entry.message as PiSessionMessageRecord;
		appendOperationalTraceItem(traceItems, buildAssistantErrorTraceItem(entry, message));
		const role = trimToNull(message.role);
		if (role === "user") {
			const promptText = extractPiSessionMessageText(message.content);
			if (promptText.trim() !== "") {
				promptParts.push({
					role: "user",
					text: promptText,
					createdAt: entry.timestamp,
				});
			}
			continue;
		}
		if (role === "assistant") {
			for (const block of normalizeContentBlocks(message.content)) {
				if (block.type === "thinking" && typeof block.thinking === "string") {
					if (block.thinking.length > 0) {
						assistant.thinking += block.thinking;
						assistant.lastUpdatedAt = entry.timestamp;
						traceItems.push({ kind: "thinking", text: block.thinking });
					}
					continue;
				}
				if (block.type === "toolCall") {
					const toolCallId = trimToNull(block.id);
					const toolName = trimToNull(block.name);
					if (!toolCallId || !toolName) {
						continue;
					}
					ensureToolCall({
						toolCallId,
						toolName,
						startedAt: entry.timestamp,
						arguments: normalizeToolArguments(block.arguments),
					});
					continue;
				}
				if (block.type === "text" && typeof block.text === "string") {
					assistant.text += block.text;
					assistant.lastUpdatedAt = entry.timestamp;
				}
			}
			usage = mergeUsageSnapshots(usage, normalizeUsageSnapshot(message.usage));
			continue;
		}
		if (role !== "toolResult") {
			continue;
		}
		const toolCallId = trimToNull(message.toolCallId);
		const toolName = trimToNull(message.toolName) ?? "tool";
		if (!toolCallId) {
			continue;
		}
		const toolCall = ensureToolCall({
			toolCallId,
			toolName,
			startedAt: entry.timestamp,
			arguments: null,
		});
		const resultValue = extractToolResultValue(message);
		const resultContent = message.content ?? null;
		const rawResultText = extractPiSessionMessageText(resultContent);
		const resultText = rawResultText.trim() === "" ? null : rawResultText;
		const resultDetails = "details" in message ? message.details : null;
		const truncated = isToolResultTruncated({ resultText, resultDetails, resultValue });
		toolCall.status = "completed";
		toolCall.completedAt = entry.timestamp;
		toolCall.isError = message.isError === true;
		toolCall.resultText = resultText;
		toolCall.truncated = truncated;
	}

	for (const event of input.events ?? []) {
		if (eventTurnRecordId(event) === input.turnRecordId) {
			appendOperationalTraceItem(traceItems, buildOperationalEventTraceItem(event));
		}
	}

	if (
		assistant.text === "" &&
		assistant.thinking === "" &&
		toolCalls.length === 0 &&
		usage === null &&
		promptParts.length === 0 &&
		traceItems.length === 0
	) {
		return undefined;
	}

	return {
		assistant,
		toolCalls,
		traceItems: ensureSortedTraceItems(traceItems),
		usage,
		piInput: buildTurnPiInputSnapshot(promptParts),
	};
}

export function buildTurnTraceFromSession(input: {
	tree: ReadonlyPiSessionTree;
	turnRecord: TraceTurnRecord;
	events?: readonly ProcessEvent[];
}): TurnTraceSnapshot | undefined {
	if (input.turnRecord.turnType !== "llm") {
		return undefined;
	}
	const continuationIndex = createTurnContinuationIndex(
		input.tree.entries as unknown as PiSessionEntry[],
	);
	return buildTurnTraceFromSlice({
		turnRecordId: input.turnRecord.id,
		turnSlice: continuationIndex.buildSlice(input.turnRecord, {
			endedAt: input.turnRecord.endedAt,
		}),
		events: input.events,
	});
}

/** Recover persisted activity when a worker ended before uploading its turn content. */
export function buildCommittedTurnTrace(input: {
	tree: ReadonlyPiSessionTree;
	turnRecord: TraceTurnRecord;
	events: readonly ProcessEvent[];
}): TurnTraceSnapshot {
	const sessionTrace = buildTurnTraceFromSession(input);
	if (
		sessionTrace &&
		(sessionTrace.assistant.text ||
			sessionTrace.assistant.thinking ||
			sessionTrace.toolCalls.length)
	)
		return sessionTrace;
	const trace = snapshotTurnTrace(
		buildLiveTurnProjectionFromEvents(
			input.events.filter((event) => eventTurnRecordId(event) === input.turnRecord.id),
		),
		sessionTrace?.piInput ?? null,
	);
	trace.usage ??= sessionTrace?.usage ?? null;
	for (const item of sessionTrace?.traceItems ?? []) {
		if (item.kind === "operational_event") appendOperationalTraceItem(trace.traceItems, item);
	}
	trace.traceItems = ensureSortedTraceItems(trace.traceItems);
	return trace;
}

export function buildTurnTracePreview(
	turnRecordId: string,
	trace: TurnTraceSnapshot | undefined,
): TurnTracePreview {
	const assistantText = truncateTextPreview(trace?.assistant.text.trim() ?? "", PREVIEW_MAX_LENGTH);
	const thinkingPreview = {
		text: reasoningPreviewTail(trace?.assistant.thinking ?? ""),
		truncated: (trace?.assistant.thinking.length ?? 0) > 1024,
	};
	const piInput = trace?.piInput ?? null;
	const userInputPreview = piInput?.fullPrompt
		? truncateTextPreview(piInput.fullPrompt.trim(), PREVIEW_MAX_LENGTH).text
		: null;
	return {
		turnRecordId,
		assistantTextPreview: assistantText.text,
		assistantTextTruncated: assistantText.truncated,
		thinkingPreview: thinkingPreview.text,
		thinkingPreviewTruncated: thinkingPreview.truncated,
		toolCallCount: trace?.toolCalls.length ?? 0,
		traceItemCount: trace?.traceItems.length ?? 0,
		hasReasoningDetails: Boolean(
			trace &&
				(trace.assistant.thinking.trim() !== "" ||
					trace.toolCalls.length > 0 ||
					trace.traceItems.length > 0 ||
					trace.piInput ||
					trace.usage),
		),
		usage: trace?.usage ?? null,
		piInput: piInput
			? {
					createdAt: piInput.createdAt,
					partCount: piInput.parts.length,
					userInputPreview,
				}
			: null,
	};
}

interface TurnTraceCollectionInput {
	tree: ReadonlyPiSessionTree;
	turnRecords: readonly TraceTurnRecord[];
	events?: readonly ProcessEvent[];
}

function visitTurnTraces(
	input: TurnTraceCollectionInput,
	visit: (turnRecordId: string, trace: TurnTraceSnapshot) => void,
): void {
	const continuationIndex = createTurnContinuationIndex(
		input.tree.entries as unknown as PiSessionEntry[],
	);
	const eventsByTurnRecordId = indexEventsByTurnRecordId(input.events);
	for (const turnRecord of input.turnRecords) {
		if (turnRecord.turnType !== "llm") {
			continue;
		}
		const trace = buildTurnTraceFromSlice({
			turnRecordId: turnRecord.id,
			turnSlice: continuationIndex.buildSlice(turnRecord, { endedAt: turnRecord.endedAt }),
			events: eventsByTurnRecordId.get(turnRecord.id),
		});
		if (trace) {
			visit(turnRecord.id, trace);
		}
	}
}

export function buildTurnTracePreviewsFromSession(
	input: TurnTraceCollectionInput,
): Record<string, TurnTracePreview> {
	const previews: Record<string, TurnTracePreview> = {};
	visitTurnTraces(input, (turnRecordId, trace) => {
		previews[turnRecordId] = buildTurnTracePreview(turnRecordId, trace);
	});
	return previews;
}

export function buildTurnTraceIndexFromSession(
	input: TurnTraceCollectionInput,
): Record<string, TurnTraceSnapshot> {
	const traces: Record<string, TurnTraceSnapshot> = {};
	visitTurnTraces(input, (turnRecordId, trace) => {
		traces[turnRecordId] = trace;
	});
	return traces;
}
