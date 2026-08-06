export function trimString(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

export function trimToNull(value: unknown): string | null {
	const trimmed = trimString(value);
	return trimmed === "" ? null : trimmed;
}

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
export function humanizeProcessLabel(identifier: unknown): string {
	return trimString(identifier)
		.replace(/[_-]+/g, " ")
		.replace(/\s+/g, " ")
		.replace(/\b\w/g, (letter) => letter.toUpperCase())
		.trim();
}
