function convertInline(value: string): string {
	return value
		.replace(/\\([\\*_`[\]()])/g, "$1")
		.replace(/`([^`\n]+)`/g, "{{$1}}")
		.replace(/\[([^\]]+)]\((https?:\/\/[^)\s]+)\)/g, "[$1|$2]")
		.replace(/(?<![*\w])\*([^*\n]+)\*(?![*\w])/g, "_$1_")
		.replace(/(?<![_\w])_([^_\n]+)_(?![_\w])/g, "_$1_")
		.replace(/\*\*([^*\n]+)\*\*/g, "*$1*")
		.replace(/__([^_\n]+)__/g, "*$1*");
}

/** Converts ticket Markdown to Jira Server/Data Center wiki markup. @internal */
export function markdownToJira(markdown: string): string {
	const lines = String(markdown ?? "")
		.replace(/\r\n?/g, "\n")
		.split("\n");
	const output: string[] = [];
	let fence: { delimiter: string; language: string; lines: string[] } | null = null;

	for (const line of lines) {
		const fenceMatch = line.match(/^(`{3,})([\w+-]*)\s*$/);
		if (fenceMatch) {
			if (fence && !fenceMatch[2] && (fenceMatch[1]?.length ?? 0) >= fence.delimiter.length) {
				output.push(
					`{code${fence.language ? `:${fence.language}` : ""}}`,
					...fence.lines,
					"{code}",
				);
				fence = null;
			} else if (!fence) {
				fence = { delimiter: fenceMatch[1] ?? "```", language: fenceMatch[2] ?? "", lines: [] };
			} else {
				fence.lines.push(line);
			}
			continue;
		}
		if (fence) {
			fence.lines.push(line);
			continue;
		}
		const heading = line.match(/^(#{1,6})\s+(.+)$/);
		if (heading) {
			output.push(`h${heading[1]?.length}. ${convertInline(heading[2] ?? "")}`);
			continue;
		}
		const list = line.match(/^(\s*)(?:([-*+])|\d+[.)])\s+(.+)$/);
		if (list) {
			const marker = list[2] ? "*" : "#";
			output.push(
				`${marker.repeat(Math.floor((list[1]?.length ?? 0) / 2) + 1)} ${convertInline(list[3] ?? "")}`,
			);
			continue;
		}
		const quote = line.match(/^>\s?(.*)$/);
		output.push(quote ? `{quote}${convertInline(quote[1] ?? "")}{quote}` : convertInline(line));
	}
	if (fence)
		output.push(`{code${fence.language ? `:${fence.language}` : ""}}`, ...fence.lines, "{code}");
	return output.join("\n");
}
