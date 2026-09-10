export function normalizeChronicleLineEndings(value: string): string {
	return value.replace(/\r\n?/g, "\n");
}

export function normalizeChronicleText(value: string): string {
	return normalizeChronicleLineEndings(value).trim();
}

export function splitChronicleLines(value: string, options: { trim?: boolean } = {}): string[] {
	const normalized = options.trim
		? normalizeChronicleText(value)
		: normalizeChronicleLineEndings(value);
	return normalized.length > 0 ? normalized.split("\n") : [];
}

export function formatCompactTokenCount(count: number): string {
	return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : count.toString();
}

export function formatChronicleDuration(
	startedAt: string | null,
	endedAt: string | null,
): string | null {
	if (!startedAt || !endedAt) return null;
	const elapsed = Date.parse(endedAt) - Date.parse(startedAt);
	if (!Number.isFinite(elapsed) || elapsed < 0) return null;
	if (elapsed < 100) return "<0.1s";
	if (elapsed < 60_000) return `${Number((elapsed / 1000).toFixed(1))}s`;
	const seconds = Math.floor(elapsed / 1000);
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
	return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

export function formatChronicleCost(total: number): string {
	if (total > 0 && total < 0.01) return "<$0.01";
	return `$${total.toFixed(2)}`;
}
