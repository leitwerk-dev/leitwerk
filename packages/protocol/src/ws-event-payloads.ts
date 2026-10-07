import { asUnknownRecord, trimToNull as readWsEventNonEmptyString } from "@leitwerk-dev/domain";

/** @internal */
export interface WsEventPayloadRecord extends Record<string, unknown> {}

/** @internal */
export interface ResolveWsEventToolCallIdOptions {
	/** @internal */
	timestamp: string;
	/** @internal */
	toolName?: string;
	/** @internal */
	ordinal?: number;
}

/** @internal */
export function asWsEventPayloadRecord(value: unknown): WsEventPayloadRecord {
	return asUnknownRecord(value) ?? {};
}

export { readWsEventNonEmptyString };

/** @internal */
export function readWsEventTimestamp(
	data: WsEventPayloadRecord,
	fallbackTimestamp: string,
): string {
	return readWsEventNonEmptyString(data.timestamp) ?? fallbackTimestamp;
}

/** @internal */
export function readWsEventTurnRecordId(data: WsEventPayloadRecord): string | null {
	return readWsEventNonEmptyString(data.turnRecordId);
}

/** @internal */
export function readWsEventPiTurnId(data: WsEventPayloadRecord): string | null {
	return readWsEventNonEmptyString(data.turnId);
}

/** @internal */
export function readWsEventStreamText(data: WsEventPayloadRecord): string | null {
	return typeof data.text === "string"
		? data.text
		: typeof data.delta === "string"
			? data.delta
			: typeof data.chunk === "string"
				? data.chunk
				: null;
}

/** @internal */
export function readWsEventToolName(data: WsEventPayloadRecord): string {
	return readWsEventNonEmptyString(data.name) ?? readWsEventNonEmptyString(data.toolName) ?? "tool";
}

/** @internal */
export function readWsEventToolArguments(
	data: WsEventPayloadRecord,
): Record<string, unknown> | null {
	return asUnknownRecord(data.arguments ?? data.args);
}

/** @internal */
export function readWsEventToolCallId(data: WsEventPayloadRecord): string | null {
	return readWsEventNonEmptyString(data.toolCallId);
}

/** @internal */
export function resolveWsEventToolCallId(
	data: WsEventPayloadRecord,
	options: ResolveWsEventToolCallIdOptions,
): string {
	return (
		readWsEventToolCallId(data) ??
		`${options.toolName ?? readWsEventToolName(data)}:${options.timestamp}${options.ordinal ? `:${options.ordinal}` : ""}`
	);
}
