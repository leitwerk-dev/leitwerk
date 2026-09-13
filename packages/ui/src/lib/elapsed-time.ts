export function elapsedMilliseconds(
	start: string | null,
	end: string | null,
	now: number | null,
): number | null {
	if (!start || (!end && now === null)) return null;
	const startMs = Date.parse(start);
	const endMs = end ? Date.parse(end) : now;
	if (!Number.isFinite(startMs) || endMs === null || !Number.isFinite(endMs) || endMs < startMs)
		return null;
	return endMs - startMs;
}

export function formatElapsedTime(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const seconds = Math.floor(ms / 1000);
	return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
