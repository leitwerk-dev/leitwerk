function fence(value: string, language = "json"): string {
	let marker = "```";
	while (value.includes(marker)) marker += "`";
	return `${marker}${language}\n${value.endsWith("\n") ? value : `${value}\n`}${marker}`;
}

export function jsonMarkdown(title: string, value: unknown): string {
	return `# ${title}\n\n${fence(JSON.stringify(value, null, 2))}\n`;
}

export function buildSummaryMarkdown(input: {
	detail: unknown;
	primaryPath: unknown;
	sourceUrl: string;
}): string {
	const detail = input.detail as Record<string, unknown>;
	return [
		"# Process snapshot summary",
		`- Source: ${input.sourceUrl}`,
		`- Process id: ${String(detail.id ?? "unknown")}`,
		`- Process type: ${String(detail.processId ?? "unknown")}`,
		`- Title: ${String(detail.title ?? "(untitled)")}`,
		`- Lifecycle: ${String(detail.lifecycleStatus ?? "unknown")}`,
		`- Selected turn: ${String(detail.selectedTurnId ?? "none")}`,
		"",
		"## Primary path",
		fence(JSON.stringify(input.primaryPath, null, 2)),
	].join("\n");
}

export function buildRecordsMarkdown(title: string, value: unknown): string {
	if (Array.isArray(value))
		return [
			`# ${title}`,
			"",
			...value.map((item, i) => `## ${i + 1}\n\n${fence(JSON.stringify(item, null, 2))}`),
		].join("\n");
	return jsonMarkdown(title, value);
}
