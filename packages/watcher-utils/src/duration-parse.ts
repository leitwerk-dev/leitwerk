import ms from "ms";

/**
 * Parse a human-friendly duration string (e.g. "150ms", "1.5s", "2 min") into
 * milliseconds. Returns `defaultMs` when the input cannot be parsed.
 *
 * `options.allowHours` is retained for existing callers; the underlying `ms`
 * parser supports hours and other common duration units by default.
 */
export function parseDurationMs(
	value: string,
	defaultMs: number,
	_options: { allowHours?: boolean } = {},
): number {
	const parsed = ms(value.trim() as ms.StringValue);
	if (!Number.isFinite(parsed) || parsed < 0) {
		return defaultMs;
	}

	return parsed;
}
