import { asUnknownRecord, trimToNull as readWsEventNonEmptyString } from "@leitwerk-dev/domain";

export interface WsEventPayloadRecord extends Record<string, unknown> {}

export interface ResolveWsEventToolCallIdOptions {
	timestamp: string;
	toolName?: string;
	ordinal?: number;
}

export function asWsEventPayloadRecord(value: unknown): WsEventPayloadRecord {
	return asUnknownRecord(value) ?? {};
}

export { readWsEventNonEmptyString };

export function readWsEventTimestamp(
	data: WsEventPayloadRecord,
	fallbackTimestamp: string,
): string {
	return readWsEventNonEmptyString(data.timestamp) ?? fallbackTimestamp;
}

export function readWsEventTurnRecordId(data: WsEventPayloadRecord): string | null {
	return readWsEventNonEmptyString(data.turnRecordId);
}

export function readWsEventPiTurnId(data: WsEventPayloadRecord): string | null {
	return readWsEventNonEmptyString(data.turnId);
}

export function readWsEventStreamText(data: WsEventPayloadRecord): string | null {
	return typeof data.text === "string"
		? data.text
		: typeof data.delta === "string"
			? data.delta
			: typeof data.chunk === "string"
				? data.chunk
				: null;
}

export function readWsEventToolName(data: WsEventPayloadRecord): string {
	return readWsEventNonEmptyString(data.name) ?? readWsEventNonEmptyString(data.toolName) ?? "tool";
}

export function readWsEventToolArguments(
	data: WsEventPayloadRecord,
): Record<string, unknown> | null {
	return asUnknownRecord(data.arguments ?? data.args);
}

export function readWsEventToolCallId(data: WsEventPayloadRecord): string | null {
	return readWsEventNonEmptyString(data.toolCallId);
}

export function resolveWsEventToolCallId(
	data: WsEventPayloadRecord,
	options: ResolveWsEventToolCallIdOptions,
): string {
	return (
		readWsEventToolCallId(data) ??
		`${options.toolName ?? readWsEventToolName(data)}:${options.timestamp}${options.ordinal ? `:${options.ordinal}` : ""}`
	);
}
