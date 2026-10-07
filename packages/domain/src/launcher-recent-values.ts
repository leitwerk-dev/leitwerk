/** @internal */
export const DEFAULT_LAUNCHER_RECENT_VALUE_LIMIT = 5;

function hasCredentialBearingAbsoluteUrl(value: string): boolean {
	if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
		return false;
	}
	try {
		const url = new URL(value);
		return url.protocol !== "file:" && (url.username !== "" || url.password !== "");
	} catch {
		return false;
	}
}

/**
 * Strip any embedded credentials (`user:pass@`) from an absolute non-`file:` URL,
 * returning the value unchanged when it is not such a URL.
 */
/** @internal */
export function redactCredentialBearingAbsoluteUrl(value: string): string {
	if (!hasCredentialBearingAbsoluteUrl(value)) {
		return value;
	}
	const url = new URL(value);
	url.username = "";
	url.password = "";
	return url.toString();
}

/** @internal */
export function normalizeLauncherRecentValue(value: unknown): string | null {
	const normalizedValue = typeof value === "string" ? value.trim() : "";
	if (!normalizedValue || hasCredentialBearingAbsoluteUrl(normalizedValue)) {
		return null;
	}
	return normalizedValue;
}

/** @internal */
export function normalizeLauncherRecentValues(
	values: readonly unknown[],
	limit = DEFAULT_LAUNCHER_RECENT_VALUE_LIMIT,
): string[] {
	const nextValues = new Set<string>();
	for (const value of values) {
		const normalizedValue = normalizeLauncherRecentValue(value);
		if (!normalizedValue || nextValues.has(normalizedValue)) {
			continue;
		}
		nextValues.add(normalizedValue);
		if (nextValues.size >= limit) {
			break;
		}
	}
	return [...nextValues];
}

/** @internal */
export function addLauncherRecentValue(
	existingValues: readonly string[],
	value: string,
	limit = DEFAULT_LAUNCHER_RECENT_VALUE_LIMIT,
): string[] {
	const normalizedValue = normalizeLauncherRecentValue(value);
	if (!normalizedValue) {
		return normalizeLauncherRecentValues(existingValues, limit);
	}
	return normalizeLauncherRecentValues([normalizedValue, ...existingValues], limit);
}
