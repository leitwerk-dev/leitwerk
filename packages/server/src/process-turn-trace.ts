import { type ProcessEvent, type ProcessTurnRecord, trimToNull } from "@leitwerk-dev/domain";
import {
	asWsEventPayloadRecord,
	buildPrimaryPathOperationalTraceItem,
	buildTrailingLinePreview,
	compareTimestampStrings,
	createTurnContinuationIndex,
	extractPiSessionMessageText,
	isPiSessionMessageEntryWithRecord,
	mergeUsageSnapshots,
	normalizeUsageSnapshot,
	type PiSessionContentBlock,
	type PiSessionEntry,
	type PiSessionMessageRecord,
	PRIMARY_PATH_OPERATIONAL_PI_EVENT_TYPES,
	type PrimaryPathOperationalTraceItemSnapshot,
	type PrimaryPathStreamingAssistantSnapshot,
	type PrimaryPathTraceItemSnapshot,
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
const THINKING_PREVIEW_LINE_COUNT = 3;
const THINKING_PREVIEW_MAX_LENGTH = 320;
const OPERATIONAL_PI_EVENT_TYPE_SET = new Set<string>(PRIMARY_PATH_OPERATIONAL_PI_EVENT_TYPES);

function composeTurnPiInputFullPrompt(parts: readonly TurnPiInputPart[]): string {
	if (parts.length === 1) {
		return parts[0]?.text ?? "";
	}
	return parts.map((part) => part.text).join(MULTI_PART_PI_INPUT_SEPARATOR);
}

function buildTurnPiInputSnapshot(parts: readonly TurnPiInputPart[]): TurnPiInputSnapshot | null {
	const firstPart = parts[0];
	if (!firstPart) {
		return null;
	}
	return {
		parts: [...parts],
		fullPrompt: composeTurnPiInputFullPrompt(parts),
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

const TOOL_TRUNCATION_BOOLEAN_KEYS = [
	"truncated",
	"isTruncated",
	"wasTruncated",
	"outputTruncated",
	"resultTruncated",
] as const;
const TOOL_TRUNCATION_TEXT_MARKERS = [
	"output truncated",
	"result truncated",
	"response was too big",
	"too large to display",
	"truncated after",
	"truncated to last",
	"truncated since",
] as const;

function readStringField(value: unknown, keys: readonly string[]): string | null {
	const record = asUnknownRecord(value);
	if (!record) {
		return null;
	}
	for (const key of keys) {
		const fieldValue = record[key];
		if (typeof fieldValue === "string" && fieldValue.trim() !== "") {
			return fieldValue;
		}
	}
	return null;
}

function readFirstStringField(values: readonly unknown[], keys: readonly string[]): string | null {
	for (const value of values) {
		const field = readStringField(value, keys);
		if (field) {
			return field;
		}
	}
	return null;
}

function readTruncationPayload(value: unknown): unknown {
	const record = asUnknownRecord(value);
	if (!record) {
		return null;
	}
	if ("truncation" in record) {
		return record.truncation;
	}
	for (const key of TOOL_TRUNCATION_BOOLEAN_KEYS) {
		if (key in record) {
			return record[key];
		}
	}
	return null;
}

function isExplicitFalseTruncationString(value: string): boolean {
	const normalized = value.trim().toLowerCase();
	return (
		normalized === "" ||
		normalized === "false" ||
		normalized === "none" ||
		normalized === "null" ||
		normalized === "no" ||
		normalized === "0"
	);
}

function isTruthyTruncationValue(value: unknown): boolean {
	if (value === null || value === undefined) {
		return false;
	}
	if (typeof value === "boolean") {
		return value;
	}
	if (typeof value === "number") {
		return Number.isFinite(value) && value > 0;
	}
	if (typeof value === "string") {
		return !isExplicitFalseTruncationString(value);
	}
	if (Array.isArray(value)) {
		return value.length > 0;
	}
	const record = asUnknownRecord(value);
	if (!record) {
		return true;
	}
	for (const key of TOOL_TRUNCATION_BOOLEAN_KEYS) {
		if (record[key] === true) {
			return true;
		}
	}
	const keys = Object.keys(record);
	if (keys.length === 0) {
		return false;
	}
	return keys.some((key) => {
		if (
			TOOL_TRUNCATION_BOOLEAN_KEYS.includes(key as (typeof TOOL_TRUNCATION_BOOLEAN_KEYS)[number])
		) {
			return false;
		}
		return isTruthyTruncationValue(record[key]);
	});
}

function isToolResultTruncated(input: {
	resultText: string | null;
	resultDetails: unknown;
	resultValue: unknown;
}): boolean {
	const normalizedText = input.resultText?.toLowerCase() ?? "";
	return (
		TOOL_TRUNCATION_TEXT_MARKERS.some((marker) => normalizedText.includes(marker)) ||
		isTruthyTruncationValue(readTruncationPayload(input.resultDetails)) ||
		isTruthyTruncationValue(readTruncationPayload(input.resultValue))
	);
}

function supportsCommittedTurnTrace(turnRecord: Pick<ProcessTurnRecord, "turnType">): boolean {
	return turnRecord.turnType === "llm";
}

type TraceTurnRecord = Pick<
	ProcessTurnRecord,
	"id" | "turnType" | "forkPiEntryId" | "resultPiEntryId" | "startedAt" | "endedAt" | "status"
>;

type PiSessionContinuationIndex = ReturnType<typeof createTurnContinuationIndex<PiSessionEntry>>;

function buildTurnSlice(
	continuationIndex: PiSessionContinuationIndex,
	turnRecord: TraceTurnRecord,
): PiSessionEntry[] {
	return supportsCommittedTurnTrace(turnRecord)
		? continuationIndex.buildSlice(turnRecord, { endedAt: turnRecord.endedAt })
		: [];
}

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
	const errorMessage = readFirstStringField([message], ["errorMessage"]);
	if (!errorMessage) {
		return null;
	}
	return buildPrimaryPathOperationalTraceItem({
		eventType: "pi.error",
		data: asWsEventPayloadRecord({
			message: errorMessage,
			errorMessage,
			provider: readFirstStringField([message], ["provider"]),
			model: readFirstStringField([message], ["model"]),
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
	const value = event.data.turnRecordId;
	return typeof value === "string" && value.trim() !== "" ? value : null;
}

function compareOperationalTraceItems(
	left: PrimaryPathOperationalTraceItemSnapshot,
	right: PrimaryPathOperationalTraceItemSnapshot,
): number {
	const timestampComparison = compareTimestampStrings(left.timestamp, right.timestamp);
	if (timestampComparison !== 0) {
		return timestampComparison;
	}
	const eventTypeComparison = left.eventType.localeCompare(right.eventType);
	if (eventTypeComparison !== 0) {
		return eventTypeComparison;
	}
	return left.message.localeCompare(right.message);
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
		return toolCall;
	};

	const ensureToolTraceItem = (toolCallId: string) => {
		if (
			traceItems.some(
				(traceItem) => traceItem.kind === "tool_call" && traceItem.toolCallId === toolCallId,
			)
		) {
			return;
		}
		traceItems.push({ kind: "tool_call", toolCallId });
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
					ensureToolTraceItem(toolCallId);
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
		const toolCall =
			toolCallsById.get(toolCallId) ??
			ensureToolCall({
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
		ensureToolTraceItem(toolCallId);
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
	if (!supportsCommittedTurnTrace(input.turnRecord)) {
		return undefined;
	}
	const continuationIndex = createTurnContinuationIndex(
		input.tree.entries as unknown as PiSessionEntry[],
	);
	return buildTurnTraceFromSlice({
		turnRecordId: input.turnRecord.id,
		turnSlice: buildTurnSlice(continuationIndex, input.turnRecord),
		events: input.events,
	});
}

export function buildTurnTracePreview(
	turnRecordId: string,
	trace: TurnTraceSnapshot | undefined,
): TurnTracePreview {
	const assistantText = truncateTextPreview(trace?.assistant.text.trim() ?? "", PREVIEW_MAX_LENGTH);
	const thinkingPreview = buildTrailingLinePreview(
		trace?.assistant.thinking ?? "",
		THINKING_PREVIEW_LINE_COUNT,
		THINKING_PREVIEW_MAX_LENGTH,
	);
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
		if (!supportsCommittedTurnTrace(turnRecord)) {
			continue;
		}
		const trace = buildTurnTraceFromSlice({
			turnRecordId: turnRecord.id,
			turnSlice: buildTurnSlice(continuationIndex, turnRecord),
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
