import MarkdownIt from "markdown-it";
import { markdownToPlainText, truncateText } from "../../lib/markdown.js";

const parser = new MarkdownIt();
const normalize = (text: string) => markdownToPlainText(text).replace(/\s+/g, " ").trim();

/** Preserve the author's content; derive navigation, never a validation verdict. */
export function presentTurnResult(markdown: string, summary?: string) {
	const tokens = parser.parse(markdown, {}).filter((token) => token.type !== "space");
	const headings: string[] = [];
	let firstParagraph = "";
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (token.level !== 0) continue;
		const inline = tokens[index + 1];
		if (token.type === "heading_open" && inline?.type === "inline") {
			headings.push(normalize(inline.content));
		} else if (token.type === "paragraph_open" && inline?.type === "inline") {
			const text = normalize(inline.content);
			const next = tokens[index + 3];
			// Older reports use a short standalone label before a list instead of a heading.
			if (
				text.length <= 80 &&
				!inline.content.includes("\n") &&
				!/[.!?]$/.test(text) &&
				(next?.type === "bullet_list_open" || next?.type === "ordered_list_open")
			)
				headings.push(text);
			else if (!firstParagraph) firstParagraph = text;
		}
	}
	const plainSummary = summary ? normalize(summary) : "";
	const plainResult = normalize(markdown);
	return {
		preview: truncateText(plainSummary || firstParagraph || plainResult, 320),
		// A summary already present at the start of the report earns no second rendering.
		separateSummary: plainSummary && !plainResult.startsWith(plainSummary) ? summary : null,
		headings: [...new Set(headings.filter(Boolean))],
	};
}
