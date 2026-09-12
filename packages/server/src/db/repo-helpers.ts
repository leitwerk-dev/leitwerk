export function parsePersistedJson<T>(value: string, label: string): T {
	try {
		return JSON.parse(value) as T;
	} catch (error) {
		throw new Error(`Malformed persisted ${label}`, { cause: error });
	}
}

export function parseMetadata(raw: string | null | undefined): Record<string, unknown> | null {
	if (!raw) return null;
	try {
		return JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return null;
	}
}

export function generateId(prefix: string): string {
	const ts = Date.now().toString(36);
	const rand = Math.random().toString(36).slice(2, 10);
	return `${prefix}_${ts}${rand}`;
}

export function now(): string {
	return new Date().toISOString();
}

export function sqliteLikePatterns(value: string | undefined): string[] {
	return (value?.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean) ?? []).map(
		(term) => `%${term.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`,
	);
}
