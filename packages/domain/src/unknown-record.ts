export function isUnknownRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asUnknownRecord(value: unknown): Record<string, unknown> | null {
	return isUnknownRecord(value) ? value : null;
}
