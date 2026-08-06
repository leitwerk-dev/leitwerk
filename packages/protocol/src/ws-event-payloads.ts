export interface WsEventPayloadRecord extends Record<string, unknown> {}

export interface ResolveWsEventToolCallIdOptions {
	timestamp: string;
	toolName?: string;
	ordinal?: number;
}

export function asWsEventPayloadRecord(value: unknown): WsEventPayloadRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as WsEventPayloadRecord)
		: {};
}

export function readWsEventNonEmptyString(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

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
	const value = data.arguments ?? data.args;
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
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
