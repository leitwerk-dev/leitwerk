export interface PiSessionMessageLike {
	role?: unknown;
	content?: unknown;
	details?: unknown;
	toolCallId?: unknown;
	toolName?: unknown;
	isError?: unknown;
	usage?: unknown;
}

export interface PiSessionMessageEntryLike {
	type?: unknown;
	message?: unknown;
}

export function isPiSessionMessageEntryType<TEntry extends { type?: unknown }>(
	entry: TEntry | undefined,
): entry is TEntry & { type: "message" } {
	return entry?.type === "message";
}

export function isPiSessionMessageRecord(value: unknown): value is PiSessionMessageLike {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isPiSessionMessageEntryWithRecord<TEntry extends PiSessionMessageEntryLike>(
	entry: TEntry | undefined,
): entry is TEntry & { type: "message"; message: NonNullable<TEntry["message"]> } {
	return isPiSessionMessageEntryType(entry) && isPiSessionMessageRecord(entry.message);
}

export function extractPiSessionMessageText(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.map((block) => {
			if (typeof block !== "object" || block === null || Array.isArray(block)) {
				return "";
			}
			const record = block as { type?: unknown; text?: unknown };
			return record.type === "text" && typeof record.text === "string" ? record.text : "";
		})
		.join("");
}
