export function normalizeMarkdownLineEndings(markdown: string): string {
	return markdown.replace(/\r\n?/g, "\n");
}

export function normalizeMarkdownText(markdown: string): string {
	return normalizeMarkdownLineEndings(markdown).trim();
}

export function normalizeOptionalMarkdown(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const normalized = normalizeMarkdownText(value);
	return normalized === "" ? null : normalized;
}
