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
