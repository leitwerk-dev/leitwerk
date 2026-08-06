import type { ProcessEvent } from "@leitwerk-dev/domain";
import type {
	PrimaryPathOperationalTraceItemSnapshot,
	PrimaryPathStreamingAssistantSnapshot,
	PrimaryPathToolCallSnapshot,
	PrimaryPathTraceItemSnapshot,
} from "./primary-path-snapshot.js";
import { compareTimestampStrings } from "./timestamp-ordering.js";
import {
	cloneUsageSnapshot,
	mergeUsageSnapshots,
	normalizeUsageSnapshot,
	type UsageSnapshot,
} from "./usage-snapshot.js";
import {
	asWsEventPayloadRecord,
	readWsEventNonEmptyString,
	readWsEventStreamText,
	readWsEventTimestamp,
	readWsEventToolArguments,
	readWsEventToolCallId,
	readWsEventToolName,
	resolveWsEventToolCallId,
	type WsEventPayloadRecord,
} from "./ws-event-payloads.js";

export interface MutableLiveTurnProjection {
	assistant: PrimaryPathStreamingAssistantSnapshot;
	toolCalls: PrimaryPathToolCallSnapshot[];
	traceItems: PrimaryPathTraceItemSnapshot[];
	usage: UsageSnapshot | null;
	toolCallsById: Map<string, PrimaryPathToolCallSnapshot>;
	openToolCallIdsByName: Map<string, string[]>;
	nextFallbackOrdinal: number;
}

export interface AppliedLiveTurnProjectionEvent {
	canonicalData: WsEventPayloadRecord;
	timestamp: string;
	toolCallId: string | null;
	toolName: string | null;
}

export const PRIMARY_PATH_OPERATIONAL_PI_EVENT_TYPES = [
	"pi.error",
	"pi.retry.start",
	"pi.retry.end",
	"pi.compaction.start",
	"pi.compaction.end",
] as const;

const PRIMARY_PATH_OPERATIONAL_PI_EVENT_TYPE_SET = new Set<string>(
	PRIMARY_PATH_OPERATIONAL_PI_EVENT_TYPES,
);

function cloneAssistant(
	assistant: PrimaryPathStreamingAssistantSnapshot,
): PrimaryPathStreamingAssistantSnapshot {
	return { ...assistant };
}

function cloneToolCall(toolCall: PrimaryPathToolCallSnapshot): PrimaryPathToolCallSnapshot {
	return {
		...toolCall,
		...(toolCall.arguments ? { arguments: { ...toolCall.arguments } } : {}),
	};
}

function cloneTraceItem(traceItem: PrimaryPathTraceItemSnapshot): PrimaryPathTraceItemSnapshot {
	return { ...traceItem };
}

function readString(value: unknown): string | null {
	return typeof value === "string" && value.trim() !== "" ? value : null;
}

function readNumber(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

function formatReason(value: unknown): string | null {
	const reason = readString(value);
	return reason ? reason.replace(/[_-]+/g, " ") : null;
}

function firstMessage(data: WsEventPayloadRecord, keys: readonly string[]): string | null {
	for (const key of keys) {
		const value = readString(data[key]);
		if (value) {
			return value;
		}
	}
	return null;
}

function retryStartFallbackMessage(data: WsEventPayloadRecord): string {
	const attempt = readNumber(data.attempt);
	const maxAttempts = readNumber(data.maxAttempts);
	const delayMs = readNumber(data.delayMs);
	const attemptLabel = attempt !== null && maxAttempts !== null ? ` ${attempt}/${maxAttempts}` : "";
	const delayLabel = delayMs !== null && delayMs > 0 ? ` in ${delayMs}ms` : "";
	return `Retry${attemptLabel} scheduled${delayLabel}.`;
}

function retryEndFallbackMessage(data: WsEventPayloadRecord): string {
	const attempt = readNumber(data.attempt);
	if (data.success === true) {
		return attempt !== null
			? `Retry sequence succeeded after ${attempt} ${attempt === 1 ? "retry" : "retries"}.`
			: "Retry sequence succeeded.";
	}
	return attempt !== null
		? `Retry sequence ended after ${attempt} ${attempt === 1 ? "retry" : "retries"}.`
		: "Retry sequence ended.";
}

export function buildPrimaryPathOperationalTraceItem(input: {
	eventType: string;
	data: WsEventPayloadRecord;
	fallbackTimestamp: string;
}): PrimaryPathOperationalTraceItemSnapshot | null {
	if (!PRIMARY_PATH_OPERATIONAL_PI_EVENT_TYPE_SET.has(input.eventType)) {
		return null;
	}
	const timestamp = readWsEventTimestamp(input.data, input.fallbackTimestamp);
	if (input.eventType === "pi.error") {
		return {
			kind: "operational_event",
			eventType: input.eventType,
			severity: "error",
			title: "Pi request failed",
			message:
				firstMessage(input.data, ["message", "errorMessage", "finalError"]) ??
				"Pi reported an error.",
			timestamp,
		};
	}
	if (input.eventType === "pi.retry.start") {
		return {
			kind: "operational_event",
			eventType: input.eventType,
			severity: "warning",
			title: "Retry scheduled",
			message:
				firstMessage(input.data, ["message", "errorMessage"]) ??
				retryStartFallbackMessage(input.data),
			timestamp,
		};
	}
	if (input.eventType === "pi.retry.end") {
		const success = input.data.success === true;
		return {
			kind: "operational_event",
			eventType: input.eventType,
			severity: success ? "success" : "error",
			title: success ? "Retry succeeded" : "Retry exhausted",
			message:
				firstMessage(input.data, ["message", "finalError", "errorMessage"]) ??
				retryEndFallbackMessage(input.data),
			timestamp,
		};
	}
	if (input.eventType === "pi.compaction.start") {
		const reason = formatReason(input.data.reason);
		return {
			kind: "operational_event",
			eventType: input.eventType,
			severity: "info",
			title: "Context compaction started",
			message: reason
				? `Pi started compacting context (${reason}).`
				: "Pi started compacting context.",
			timestamp,
		};
	}
	if (input.eventType === "pi.compaction.end") {
		const reason = formatReason(input.data.reason);
		const errorMessage = firstMessage(input.data, ["errorMessage", "message"]);
		const aborted = input.data.aborted === true;
		const willRetry = input.data.willRetry === true;
		const statusMessage = errorMessage
			? errorMessage
			: aborted
				? "Context compaction was cancelled."
				: `Pi compacted context${reason ? ` (${reason})` : ""}.${willRetry ? " Pi will continue automatically." : ""}`;
		return {
			kind: "operational_event",
			eventType: input.eventType,
			severity: errorMessage ? "error" : aborted ? "warning" : "success",
			title: errorMessage
				? "Context compaction failed"
				: aborted
					? "Context compaction cancelled"
					: "Context compacted",
			message: statusMessage,
			timestamp,
		};
	}
	return null;
}

function addOpenToolCallId(
	projection: MutableLiveTurnProjection,
	toolName: string,
	toolCallId: string,
) {
	const ids = projection.openToolCallIdsByName.get(toolName) ?? [];
	ids.push(toolCallId);
	projection.openToolCallIdsByName.set(toolName, ids);
}

function consumeLatestOpenToolCallId(
	projection: MutableLiveTurnProjection,
	toolName: string,
): string | null {
	const ids = projection.openToolCallIdsByName.get(toolName);
	if (!ids || ids.length === 0) {
		return null;
	}
	const toolCallId = ids.pop() ?? null;
	if (ids.length === 0) {
		projection.openToolCallIdsByName.delete(toolName);
	} else {
		projection.openToolCallIdsByName.set(toolName, ids);
	}
	return toolCallId;
}

function removeOpenToolCallId(projection: MutableLiveTurnProjection, toolCallId: string) {
	for (const [toolName, ids] of projection.openToolCallIdsByName.entries()) {
		const nextIds = ids.filter((candidate) => candidate !== toolCallId);
		if (nextIds.length === ids.length) {
			continue;
		}
		if (nextIds.length === 0) {
			projection.openToolCallIdsByName.delete(toolName);
		} else {
			projection.openToolCallIdsByName.set(toolName, nextIds);
		}
		return;
	}
}

function canonicalizeToolCallId(input: {
	projection: MutableLiveTurnProjection;
	data: WsEventPayloadRecord;
	timestamp: string;
	toolName: string;
	preferOpenCall: boolean;
}): string {
	const explicitToolCallId = readWsEventToolCallId(input.data);
	if (explicitToolCallId) {
		if (input.preferOpenCall) {
			removeOpenToolCallId(input.projection, explicitToolCallId);
		}
		return explicitToolCallId;
	}
	if (input.preferOpenCall) {
		const openToolCallId = consumeLatestOpenToolCallId(input.projection, input.toolName);
		if (openToolCallId) {
			return openToolCallId;
		}
	}
	return resolveWsEventToolCallId(input.data, {
		timestamp: input.timestamp,
		toolName: input.toolName,
		ordinal: input.projection.nextFallbackOrdinal++,
	});
}

function appendThinkingTraceText(projection: MutableLiveTurnProjection, text: string): void {
	if (text.length === 0) {
		return;
	}
	const lastTraceItem = projection.traceItems.at(-1);
	if (lastTraceItem?.kind === "thinking") {
		lastTraceItem.text += text;
		return;
	}
	projection.traceItems.push({
		kind: "thinking",
		text,
	});
}

function ensureToolTraceItem(projection: MutableLiveTurnProjection, toolCallId: string): void {
	if (
		projection.traceItems.some(
			(traceItem) => traceItem.kind === "tool_call" && traceItem.toolCallId === toolCallId,
		)
	) {
		return;
	}
	projection.traceItems.push({
		kind: "tool_call",
		toolCallId,
	});
}

export function createMutableLiveTurnProjection(): MutableLiveTurnProjection {
	return {
		assistant: {
			text: "",
			thinking: "",
			lastUpdatedAt: null,
		},
		toolCalls: [],
		traceItems: [],
		usage: null,
		toolCallsById: new Map<string, PrimaryPathToolCallSnapshot>(),
		openToolCallIdsByName: new Map<string, string[]>(),
		nextFallbackOrdinal: 1,
	};
}

export function snapshotLiveTurnProjection(projection: MutableLiveTurnProjection): {
	assistant: PrimaryPathStreamingAssistantSnapshot;
	toolCalls: PrimaryPathToolCallSnapshot[];
	traceItems: PrimaryPathTraceItemSnapshot[];
	usage: UsageSnapshot | null;
} {
	return {
		assistant: cloneAssistant(projection.assistant),
		toolCalls: projection.toolCalls.map(cloneToolCall),
		traceItems: projection.traceItems.map(cloneTraceItem),
		usage: cloneUsageSnapshot(projection.usage),
	};
}

export function applyPiEventToLiveTurnProjection(
	projection: MutableLiveTurnProjection,
	input: {
		eventType: string;
		data: WsEventPayloadRecord;
		fallbackTimestamp: string;
	},
): AppliedLiveTurnProjectionEvent {
	const timestamp = readWsEventTimestamp(input.data, input.fallbackTimestamp);
	if (input.eventType === "pi.stream.delta") {
		const text = readWsEventStreamText(input.data);
		if (text) {
			if (readWsEventNonEmptyString(input.data.streamType) === "thinking") {
				projection.assistant.thinking += text;
				appendThinkingTraceText(projection, text);
			} else {
				projection.assistant.text += text;
			}
			projection.assistant.lastUpdatedAt = timestamp;
		}
		return {
			canonicalData: input.data,
			timestamp,
			toolCallId: null,
			toolName: null,
		};
	}

	if (input.eventType === "pi.tool.call") {
		const toolName = readWsEventToolName(input.data);
		const toolCallId = canonicalizeToolCallId({
			projection,
			data: input.data,
			timestamp,
			toolName,
			preferOpenCall: false,
		});
		const canonicalData =
			readWsEventToolCallId(input.data) === toolCallId ? input.data : { ...input.data, toolCallId };
		const existingToolCall = projection.toolCallsById.get(toolCallId);
		if (!existingToolCall) {
			const toolCall: PrimaryPathToolCallSnapshot = {
				toolCallId,
				toolName,
				status: "running",
				startedAt: timestamp,
				completedAt: null,
				arguments: readWsEventToolArguments(canonicalData),
				result: null,
				isError: false,
			};
			projection.toolCalls.push(toolCall);
			projection.toolCallsById.set(toolCallId, toolCall);
		}
		ensureToolTraceItem(projection, toolCallId);
		addOpenToolCallId(projection, toolName, toolCallId);
		return {
			canonicalData,
			timestamp,
			toolCallId,
			toolName,
		};
	}

	if (input.eventType === "pi.tool.result") {
		const toolName = readWsEventToolName(input.data);
		const toolCallId = canonicalizeToolCallId({
			projection,
			data: input.data,
			timestamp,
			toolName,
			preferOpenCall: true,
		});
		const canonicalData =
			readWsEventToolCallId(input.data) === toolCallId ? input.data : { ...input.data, toolCallId };
		const existingToolCall = projection.toolCallsById.get(toolCallId);
		if (existingToolCall) {
			existingToolCall.status = "completed";
			existingToolCall.completedAt = timestamp;
			existingToolCall.result = canonicalData.result ?? null;
			existingToolCall.isError = canonicalData.isError === true;
			removeOpenToolCallId(projection, toolCallId);
		} else {
			const completedToolCall: PrimaryPathToolCallSnapshot = {
				toolCallId,
				toolName,
				status: "completed",
				startedAt: timestamp,
				completedAt: timestamp,
				arguments: null,
				result: canonicalData.result ?? null,
				isError: canonicalData.isError === true,
			};
			projection.toolCalls.push(completedToolCall);
			projection.toolCallsById.set(toolCallId, completedToolCall);
		}
		ensureToolTraceItem(projection, toolCallId);
		return {
			canonicalData,
			timestamp,
			toolCallId,
			toolName,
		};
	}

	if (input.eventType === "pi.usage") {
		projection.usage = mergeUsageSnapshots(projection.usage, normalizeUsageSnapshot(input.data));
		return {
			canonicalData: input.data,
			timestamp,
			toolCallId: null,
			toolName: null,
		};
	}

	const operationalTraceItem = buildPrimaryPathOperationalTraceItem({
		eventType: input.eventType,
		data: input.data,
		fallbackTimestamp: input.fallbackTimestamp,
	});
	if (operationalTraceItem) {
		projection.traceItems.push(operationalTraceItem);
		return {
			canonicalData: input.data,
			timestamp: operationalTraceItem.timestamp,
			toolCallId: null,
			toolName: null,
		};
	}

	return {
		canonicalData: input.data,
		timestamp,
		toolCallId: null,
		toolName: null,
	};
}

function compareProcessEventsChronologically(left: ProcessEvent, right: ProcessEvent): number {
	const leftTimestamp = readWsEventTimestamp(asWsEventPayloadRecord(left.data), left.createdAt);
	const rightTimestamp = readWsEventTimestamp(asWsEventPayloadRecord(right.data), right.createdAt);
	const timestampComparison = compareTimestampStrings(leftTimestamp, rightTimestamp);
	if (timestampComparison !== 0) {
		return timestampComparison;
	}
	const createdAtComparison = compareTimestampStrings(left.createdAt, right.createdAt);
	if (createdAtComparison !== 0) {
		return createdAtComparison;
	}
	return left.id.localeCompare(right.id);
}

export function buildLiveTurnProjectionFromEvents(
	events: readonly ProcessEvent[],
): MutableLiveTurnProjection {
	const projection = createMutableLiveTurnProjection();
	for (const event of [...events].sort(compareProcessEventsChronologically)) {
		applyPiEventToLiveTurnProjection(projection, {
			eventType: event.eventType,
			data: asWsEventPayloadRecord(event.data),
			fallbackTimestamp: event.createdAt,
		});
	}
	return projection;
}
