export interface TextPreview {
	text: string;
	truncated: boolean;
}

export function truncateTextPreview(value: string, maxLength: number): TextPreview {
	return value.length <= maxLength
		? { text: value, truncated: false }
		: { text: value.slice(0, maxLength).trimEnd(), truncated: true };
}

export function buildTrailingLinePreview(
	value: string,
	lineCount: number,
	maxLength: number,
): TextPreview {
	const lines = value.replace(/\r\n?/g, "\n").split("\n");
	if (lines.length === 1 && lines[0] === "") return { text: "", truncated: false };

	let text = lines.slice(-lineCount).join("\n");
	let truncated = lines.length > lineCount;
	if (text.length > maxLength) {
		text = text.slice(-maxLength);
		truncated = true;
	}
	if (truncated) {
		const previewLines = text.split("\n");
		previewLines[0] = previewLines[0] ? `… ${previewLines[0]}` : "…";
		text = previewLines.join("\n");
	}
	return { text, truncated };
}
