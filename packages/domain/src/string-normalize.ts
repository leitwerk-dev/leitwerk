/** @internal */
export function toErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message.trim() !== "") {
		return error.message;
	}
	return String(error);
}

/** Return non-blank strings verbatim; unlike trimToNull, preserve surrounding whitespace. */
/** @internal */
export function readNonBlankString(value: unknown): string | null {
	return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** @internal */
export function trimString(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

/** @internal */
export function trimToNull(value: unknown): string | null {
	const trimmed = trimString(value);
	return trimmed === "" ? null : trimmed;
}

/** @internal */
export function normalizeStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.map((entry) => trimString(entry)).filter((entry) => entry.length > 0);
}

/**
 * Single source of truth for turning an internal identifier (an action id,
 * outcome id, or trigger) into a human-readable Title Case label, e.g.
 * `approve_plan` -> `Approve Plan`. All operator-facing surfaces (action forms,
 * flow diagrams) must route through this so the translation lives in one place
 * and can later be swapped for a localized lookup.
 */
/** @internal */
export function humanizeProcessLabel(identifier: unknown): string {
	return trimString(identifier)
		.replace(/[_-]+/g, " ")
		.replace(/\s+/g, " ")
		.replace(/\b\w/g, (letter) => letter.toUpperCase())
		.trim();
}

const IDENTIFIER_WORD_LABELS: Record<string, string> = {
	api: "API",
	id: "ID",
	llm: "LLM",
	mr: "MR",
	pi: "Pi",
	ui: "UI",
};

/** Display an identifier with known acronyms, preserving the remaining spelling. */
/** @internal */
export function formatProcessIdentifier(value: string): string {
	return value
		.split(/[_-]+/)
		.filter((part) => part.length > 0)
		.map((part) => {
			const normalizedPart = part.toLowerCase();
			return IDENTIFIER_WORD_LABELS[normalizedPart] ?? part.charAt(0).toUpperCase() + part.slice(1);
		})
		.join(" ");
}
