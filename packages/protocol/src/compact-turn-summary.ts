import type {
	PrimaryPathActiveTurnSnapshot,
	PrimaryPathToolCallSnapshot,
} from "./primary-path-snapshot.js";
import {
	mergeUsageSnapshots,
	normalizeUsageSnapshot,
	type UsageSnapshot,
} from "./usage-snapshot.js";
import {
	readWsEventStreamText,
	readWsEventTimestamp,
	readWsEventToolCallId,
	readWsEventToolName,
} from "./ws-event-payloads.js";

export const REASONING_PREVIEW_MAX_CHARS = 1_024;

export interface CompactTurnSummary {
	assistant: { text: string; thinking: string; lastUpdatedAt: string | null };
	currentTool: Pick<
		PrimaryPathToolCallSnapshot,
		"toolCallId" | "toolName" | "status" | "isError"
	> | null;
	usage: UsageSnapshot | null;
	toolCallCount: number;
	traceItemCount: number;
	/** The last persisted event incorporated into this projection. */
	throughEventSequence: number;
	lastTraceKind: "thinking" | "tool_call" | "operational_event" | null;
}

/** Initial-page state. It never contains trace items, tool arguments or results. */
export interface CompactActiveTurnSnapshot
	extends CompactTurnSummary,
		Pick<
			PrimaryPathActiveTurnSnapshot,
			"turnRecordId" | "turnId" | "turnType" | "pathType" | "startedAt"
		> {
	summaryPending: boolean;
}

export function emptyCompactTurnSummary(): CompactTurnSummary {
	return {
		assistant: { text: "", thinking: "", lastUpdatedAt: null },
		currentTool: null,
		usage: null,
		toolCallCount: 0,
		traceItemCount: 0,
		throughEventSequence: 0,
		lastTraceKind: null,
	};
}

/** Retain paragraph context; wrapping and blank-line removal belong to the preview viewport. */
export function reasoningPreviewTail(text: string): string {
	const normalized = text.replace(/\r\n?/g, "\n");
	const lines = normalized.split("\n").filter((line) => line.trim() !== "");
	const separator = /\n[^\S\n]*$/.test(normalized) ? "\n" : "";
	return (lines.join("\n") + separator).slice(-REASONING_PREVIEW_MAX_CHARS);
}

export function applyEventToCompactTurnSummary(
	previous: CompactTurnSummary,
	event: {
		eventType: string;
		data: Record<string, unknown>;
		createdAt: string;
		eventSequence: number;
	},
): CompactTurnSummary {
	if (event.eventSequence <= previous.throughEventSequence) return previous;
	const next = {
		...previous,
		assistant: { ...previous.assistant },
		throughEventSequence: event.eventSequence,
	};
	const { eventType, data } = event;
	if (eventType === "pi.stream.delta") {
		const text = readWsEventStreamText(data);
		const key = data.streamType === "thinking" ? "thinking" : "text";
		next.assistant[key] = reasoningPreviewTail(next.assistant[key] + text);
		if (text) next.assistant.lastUpdatedAt = readWsEventTimestamp(data, event.createdAt);
		if (key === "thinking" && text) {
			if (next.lastTraceKind !== "thinking") next.traceItemCount++;
			next.lastTraceKind = "thinking";
		}
	} else if (eventType === "pi.tool.call" || eventType === "pi.tool.result") {
		const isResult = eventType === "pi.tool.result";
		const toolCallId = (readWsEventToolCallId(data) ?? `tool-${event.eventSequence}`).slice(0, 256);
		if (!isResult) {
			next.toolCallCount++;
			next.traceItemCount++;
			next.lastTraceKind = "tool_call";
		}
		if (!isResult || !next.currentTool || next.currentTool.toolCallId === toolCallId) {
			next.currentTool = {
				toolCallId: toolCallId.slice(0, 256),
				toolName: readWsEventToolName(data).slice(0, 256),
				status: isResult ? "completed" : "running",
				isError: data.isError === true,
			};
		}
	} else if (eventType === "pi.usage") {
		next.usage = mergeUsageSnapshots(next.usage, normalizeUsageSnapshot(data));
	} else if (
		[
			"pi.error",
			"pi.retry.start",
			"pi.retry.end",
			"pi.compaction.start",
			"pi.compaction.end",
		].includes(eventType)
	) {
		next.traceItemCount++;
		next.lastTraceKind = "operational_event";
	}
	return next;
}
