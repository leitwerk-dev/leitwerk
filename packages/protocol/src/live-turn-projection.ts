import {
	type ProcessEvent,
	readFiniteNumber as readNumber,
	readNonBlankString as readString,
} from "@leitwerk-dev/domain";
import type { TurnTraceSnapshot, TurnTraceToolCallSnapshot } from "./http-contracts.js";
import { extractPiSessionMessageText } from "./pi-session-message.js";
import type {
	PrimaryPathActiveTurnSnapshot,
	PrimaryPathOperationalTraceItemSnapshot,
	PrimaryPathStreamingAssistantSnapshot,
	PrimaryPathToolCallSnapshot,
	PrimaryPathTraceItemSnapshot,
} from "./primary-path-snapshot.js";
import { compareTimestampStrings } from "./timestamp-ordering.js";
import { isToolResultTruncated } from "./tool-result-truncation.js";
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

interface ProjectionToolCall extends PrimaryPathToolCallSnapshot {
	restoredResult?: Pick<TurnTraceToolCallSnapshot, "resultText" | "truncated">;
}

interface LiveTurnProjectionState {
	assistant: PrimaryPathStreamingAssistantSnapshot;
	traceItems: PrimaryPathTraceItemSnapshot[];
	usage: UsageSnapshot | null;
	toolCallsById: Map<string, ProjectionToolCall>;
	nextFallbackOrdinal: number;
}

/** @internal */
export interface LiveTurnProjectionEvent {
	/** @internal */
	eventType: string;
	/** @internal */
	data: WsEventPayloadRecord;
	/** @internal */
	fallbackTimestamp: string;
}

/** @internal */
export type LiveTurnSnapshot = Pick<
	PrimaryPathActiveTurnSnapshot,
	"assistant" | "toolCalls" | "traceItems" | "usage"
>;

/** Projection of events already scoped and ordered by the caller. @internal */
export interface TurnTraceProjection {
	/** Canonicalize and incorporate one event. Transport deduplication belongs to the caller. @internal */
	apply(event: LiveTurnProjectionEvent): AppliedLiveTurnProjectionEvent;
	/** Present retained content, preserving the restored prompt unless one is supplied. @internal */
	snapshot(piInput?: TurnTraceSnapshot["piInput"]): TurnTraceSnapshot;
}

/** Event-backed projection retaining original tool results. @internal */
export interface LiveTurnProjection extends TurnTraceProjection {
	/** Read the recorded result values as well as the projected activity. @internal */
	rawSnapshot(): LiveTurnSnapshot;
}

/** @internal */
export interface AppliedLiveTurnProjectionEvent {
	/** @internal */
	canonicalData: WsEventPayloadRecord;
	/** @internal */
	timestamp: string;
	/** @internal */
	toolCallId: string | null;
	/** @internal */
	toolName: string | null;
	/** Aggregate usage without copying the full activity history. @internal */
	usage: UsageSnapshot | null;
}

/** @internal */
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

function cloneToolCall(toolCall: ProjectionToolCall): ProjectionToolCall {
	return {
		...toolCall,
		...(toolCall.arguments ? { arguments: { ...toolCall.arguments } } : {}),
	};
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

/** @internal */
export function buildPrimaryPathOperationalTraceItem(input: {
	/** @internal */
	eventType: string;
	/** @internal */
	data: WsEventPayloadRecord;
	/** @internal */
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

function canonicalizeToolCallId(input: {
	projection: LiveTurnProjectionState;
	data: WsEventPayloadRecord;
	timestamp: string;
	toolName: string;
	preferOpenCall: boolean;
}): string {
	const explicitToolCallId = readWsEventToolCallId(input.data);
	if (explicitToolCallId) return explicitToolCallId;
	if (input.preferOpenCall) {
		const openToolCall = [...input.projection.toolCallsById.values()]
			.reverse()
			.find((tool) => tool.status === "running" && tool.toolName === input.toolName);
		if (openToolCall) return openToolCall.toolCallId;
	}
	// Replayed canonical IDs and restored snapshots do not retain the old ordinal.
	// Reserve their identities by checking the index, without interpreting ID strings.
	let toolCallId: string;
	do {
		toolCallId = resolveWsEventToolCallId(input.data, {
			timestamp: input.timestamp,
			toolName: input.toolName,
			ordinal: input.projection.nextFallbackOrdinal++,
		});
	} while (input.projection.toolCallsById.has(toolCallId));
	return toolCallId;
}

function appendThinkingTraceText(projection: LiveTurnProjectionState, text: string): void {
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

function ensureToolTraceItem(projection: LiveTurnProjectionState, toolCallId: string): void {
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

function createProjectionState(): LiveTurnProjectionState {
	return {
		assistant: {
			text: "",
			thinking: "",
			lastUpdatedAt: null,
		},
		traceItems: [],
		usage: null,
		toolCallsById: new Map<string, ProjectionToolCall>(),
		nextFallbackOrdinal: 1,
	};
}

function snapshotLiveTurnProjection(projection: LiveTurnProjectionState): LiveTurnSnapshot {
	return {
		assistant: { ...projection.assistant },
		toolCalls: Array.from(projection.toolCallsById.values(), (toolCall) => {
			const { restoredResult: _restoredResult, ...snapshot } = cloneToolCall(toolCall);
			return snapshot;
		}),
		traceItems: projection.traceItems.map((item) => ({ ...item })),
		usage: cloneUsageSnapshot(projection.usage),
	};
}

function applyPiEventToLiveTurnProjection(
	projection: LiveTurnProjectionState,
	input: LiveTurnProjectionEvent,
): AppliedLiveTurnProjectionEvent {
	let timestamp = readWsEventTimestamp(input.data, input.fallbackTimestamp);
	let canonicalData = input.data;
	let toolCallId: string | null = null;
	let toolName: string | null = null;
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
	} else if (input.eventType === "pi.tool.call" || input.eventType === "pi.tool.result") {
		const isResult = input.eventType === "pi.tool.result";
		toolName = readWsEventToolName(input.data);
		toolCallId = canonicalizeToolCallId({
			projection,
			data: input.data,
			timestamp,
			toolName,
			preferOpenCall: isResult,
		});
		canonicalData =
			readWsEventToolCallId(input.data) === toolCallId ? input.data : { ...input.data, toolCallId };
		const existingToolCall = projection.toolCallsById.get(toolCallId);
		const toolCall: ProjectionToolCall = existingToolCall ?? {
			toolCallId,
			toolName,
			status: "running",
			startedAt: timestamp,
			completedAt: null,
			arguments: isResult ? null : readWsEventToolArguments(canonicalData),
			result: null,
			isError: false,
		};
		if (!existingToolCall) projection.toolCallsById.set(toolCallId, toolCall);
		if (isResult) {
			toolCall.status = "completed";
			toolCall.completedAt = timestamp;
			toolCall.result = canonicalData.result ?? null;
			delete toolCall.restoredResult;
			toolCall.isError = canonicalData.isError === true;
		}
		ensureToolTraceItem(projection, toolCallId);
	} else if (input.eventType === "pi.usage") {
		projection.usage = mergeUsageSnapshots(projection.usage, normalizeUsageSnapshot(input.data));
	} else {
		const operationalTraceItem = buildPrimaryPathOperationalTraceItem(input);
		if (operationalTraceItem) {
			projection.traceItems.push(operationalTraceItem);
			timestamp = operationalTraceItem.timestamp;
		}
	}

	return {
		canonicalData,
		timestamp,
		toolCallId,
		toolName,
		usage: cloneUsageSnapshot(projection.usage),
	};
}

function compareProcessEventsChronologically(left: ProcessEvent, right: ProcessEvent): number {
	if (left.eventSequence !== undefined && right.eventSequence !== undefined) {
		return left.eventSequence - right.eventSequence;
	}
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

function snapshotTurnTrace(
	projection: LiveTurnProjectionState,
	piInput: TurnTraceSnapshot["piInput"],
): TurnTraceSnapshot {
	return {
		assistant: { ...projection.assistant },
		traceItems: projection.traceItems.map((item) => ({ ...item })),
		usage: cloneUsageSnapshot(projection.usage),
		piInput,
		toolCalls: Array.from(projection.toolCallsById.values(), (toolCall) => {
			const { result, restoredResult, ...tool } = cloneToolCall(toolCall);
			if (restoredResult) return { ...tool, ...restoredResult };
			const record =
				result && typeof result === "object" ? (result as Record<string, unknown>) : null;
			const resultText =
				result == null
					? null
					: typeof result === "string"
						? result
						: record && "content" in record
							? extractPiSessionMessageText(record.content)
							: JSON.stringify(result, null, 2);
			return {
				...tool,
				resultText,
				truncated: isToolResultTruncated({
					resultText,
					resultDetails: record?.details,
					resultValue: result,
				}),
			};
		}),
	};
}

function traceProjection(
	state: LiveTurnProjectionState,
	retainedPiInput: TurnTraceSnapshot["piInput"] = null,
): TurnTraceProjection {
	return {
		apply: (event) => applyPiEventToLiveTurnProjection(state, event),
		snapshot: (piInput = retainedPiInput) => snapshotTurnTrace(state, piInput),
	};
}

/** Start empty, or replay recorded events in their persisted order. @internal */
export function createLiveTurnProjection(events: readonly ProcessEvent[] = []): LiveTurnProjection {
	const state = createProjectionState();
	for (const event of [...events].sort(compareProcessEventsChronologically)) {
		applyPiEventToLiveTurnProjection(state, {
			eventType: event.eventType,
			data: asWsEventPayloadRecord(event.data),
			fallbackTimestamp: event.createdAt,
		});
	}
	return {
		...traceProjection(state),
		rawSnapshot: () => snapshotLiveTurnProjection(state),
	};
}

/**
 * Resume presentation from a Trace, including correlation for its running tools.
 * A Trace retains displayed results, not the original structured tool results.
 * @internal
 */
export function restoreTurnTraceProjection(trace: TurnTraceSnapshot): TurnTraceProjection {
	const state = createProjectionState();
	state.assistant = { ...trace.assistant };
	state.traceItems = trace.traceItems.map((item) => ({ ...item }));
	state.usage = cloneUsageSnapshot(trace.usage);
	for (const { resultText, truncated, ...tool } of trace.toolCalls) {
		const toolCall = cloneToolCall({
			...tool,
			result: null,
			restoredResult: { resultText, truncated },
		});
		state.toolCallsById.set(toolCall.toolCallId, toolCall);
	}
	return traceProjection(state, trace.piInput);
}
