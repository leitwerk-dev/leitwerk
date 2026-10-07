/** @internal */
export interface PiSessionMessageLike {
	/** @internal */
	role?: unknown;
	/** @internal */
	content?: unknown;
	/** @internal */
	details?: unknown;
	/** @internal */
	toolCallId?: unknown;
	/** @internal */
	toolName?: unknown;
	/** @internal */
	isError?: unknown;
	/** @internal */
	usage?: unknown;
}

/** @internal */
export interface PiSessionMessageEntryLike {
	/** @internal */
	type?: unknown;
	/** @internal */
	message?: unknown;
}

/** @internal */
export function isPiSessionMessageEntryType<
	TEntry extends {
		/** @internal */
		type?: unknown;
	},
>(entry: TEntry | undefined): entry is TEntry & { type: "message" } {
	return entry?.type === "message";
}

/** @internal */
export function isPiSessionMessageRecord(value: unknown): value is PiSessionMessageLike {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @internal */
export function isPiSessionMessageEntryWithRecord<TEntry extends PiSessionMessageEntryLike>(
	entry: TEntry | undefined,
): entry is TEntry & { type: "message"; message: NonNullable<TEntry["message"]> } {
	return isPiSessionMessageEntryType(entry) && isPiSessionMessageRecord(entry.message);
}

/** @internal */
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
