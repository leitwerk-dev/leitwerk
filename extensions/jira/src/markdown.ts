import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";

const markdownParser = new MarkdownIt({ html: false, linkify: false });
const normalizeNewlines = (value: string) => value.replace(/\r\n?/g, "\n");
const escapeMarkdown = (value: string) => value.replace(/[\\`*_[\]<>|~]/g, "\\$&");
const escapeJira = (value: string) =>
	value.replace(/[\\*_{}[\]|!+^~]/g, "\\$&").replace(/(?<!\w)-(?=\S)|(?<=\S)-(?!\w)/g, "\\-");

function closingToken(tokens: Token[], start: number): number {
	let depth = 0;
	for (let index = start; index < tokens.length; index++) {
		depth += tokens[index]?.nesting ?? 0;
		if (depth === 0) return index;
	}
	return tokens.length;
}

function markdownInlineToJira(tokens: Token[]): string {
	const output: string[] = [];
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (!token) continue;
		if (token.type === "link_open") {
			const end = closingToken(tokens, index);
			output.push(
				`[${markdownInlineToJira(tokens.slice(index + 1, end))}|${token.attrGet("href") ?? ""}]`,
			);
			index = end;
		} else if (token.type === "code_inline") output.push(`{{${token.content}}}`);
		else if (token.type.startsWith("strong_")) output.push("*");
		else if (token.type.startsWith("em_")) output.push("_");
		else if (token.type.startsWith("s_")) output.push("-");
		else if (token.type === "softbreak") output.push("\n");
		else if (token.type === "hardbreak") output.push("\\\\\n");
		else if (token.type === "image")
			output.push(`[${escapeJira(token.content)}|${token.attrGet("src") ?? ""}]`);
		else
			output.push(
				token.children ? markdownInlineToJira(token.children) : escapeJira(token.content),
			);
	}
	return output.join("");
}

function markdownTableToJira(tokens: Token[]): string {
	const rows: string[] = [];
	for (let index = 0; index < tokens.length; index++) {
		if (tokens[index]?.type !== "tr_open") continue;
		const end = closingToken(tokens, index);
		const row = tokens.slice(index + 1, end);
		const separator = row.some((token) => token.type === "th_open") ? "||" : "|";
		const cells = row
			.filter((token) => token.type === "inline")
			.map((token) => markdownInlineToJira(token.children ?? []));
		rows.push(`${separator}${cells.join(separator)}${separator}`);
		index = end;
	}
	return rows.join("\n");
}

function markdownBlocksToJira(tokens: Token[], listMarkers = ""): string[] {
	const output: string[] = [];
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (!token) continue;
		if (token.type === "fence" || token.type === "code_block") {
			const language = /^[\w+-]+/.exec(token.info.trim())?.[0] ?? "";
			output.push(
				`{code${language ? `:${language}` : ""}}\n${token.content.replace(/\n$/, "")}\n{code}`,
			);
		} else if (token.type === "hr") output.push("----");
		else if (token.nesting === 1) {
			const end = closingToken(tokens, index);
			const inner = tokens.slice(index + 1, end);
			if (token.type === "bullet_list_open" || token.type === "ordered_list_open") {
				const markers = listMarkers + (token.type === "bullet_list_open" ? "*" : "#");
				const items: string[] = [];
				for (let item = 0; item < inner.length; item++) {
					if (inner[item]?.type !== "list_item_open") continue;
					const itemEnd = closingToken(inner, item);
					const blocks = markdownBlocksToJira(inner.slice(item + 1, itemEnd), markers);
					items.push(`${markers} ${blocks.join("\n")}`);
					item = itemEnd;
				}
				output.push(items.join("\n"));
			} else if (token.type === "blockquote_open")
				output.push(`{quote}\n${markdownBlocksToJira(inner, listMarkers).join("\n\n")}\n{quote}`);
			else if (token.type === "table_open") output.push(markdownTableToJira(inner));
			else {
				const text = markdownBlocksToJira(inner, listMarkers).join("\n\n");
				output.push(token.type === "heading_open" ? `${token.tag}. ${text}` : text);
			}
			index = end;
		} else if (token.type === "inline") output.push(markdownInlineToJira(token.children ?? []));
		else if (token.content) output.push(escapeJira(token.content));
	}
	return output;
}

/** Converts ticket Markdown to Jira Server/Data Center wiki markup. @internal */
export function markdownToJira(markdown: string): string {
	return markdownBlocksToJira(markdownParser.parse(normalizeNewlines(markdown ?? ""), {})).join(
		"\n\n",
	);
}

function backtickDelimiter(value: string, minimum: number): string {
	const lengths = [...value.matchAll(/`+/g)].map((match) => match[0].length + 1);
	return "`".repeat(Math.max(minimum, ...lengths));
}

function markdownCodeSpan(value: string): string {
	const delimiter = backtickDelimiter(value, 1);
	const pad = /^`|`$|^ .* $/s.test(value) ? " " : "";
	return `${delimiter}${pad}${value}${pad}${delimiter}`;
}

function literalEnd(value: string, start: number): number | null {
	if (value.startsWith("{{", start)) {
		const closing = /}{2,}/.exec(value.slice(start + 2));
		return closing ? start + 2 + closing.index + closing[0].length : null;
	}
	if (value[start] === "[" || value[start] === "{") {
		const close = value[start] === "[" ? "]" : "}";
		for (let index = start + 1; index < value.length; index++) {
			if (value[index] === "\\") index++;
			else if (value[index] === close) return index + 1;
		}
	}
	return null;
}

function jiraEmphasisEnd(value: string, start: number, delimiter: string): number | null {
	for (let index = start + 1; index < value.length; index++) {
		if (value[index] === "\\") {
			index++;
			continue;
		}
		const protectedEnd = literalEnd(value, index);
		if (protectedEnd !== null) {
			index = protectedEnd - 1;
			continue;
		}
		if (
			value[index] === delimiter &&
			index > start + 1 &&
			!/\s/.test(value[index - 1] ?? "") &&
			!/[\w]/.test(value[index + 1] ?? "")
		)
			return index;
	}
	return null;
}

function jiraInlineToMarkdown(value: string): string {
	const output: string[] = [];
	for (let index = 0; index < value.length; index++) {
		const char = value[index] ?? "";
		if (value.startsWith("\\\\", index)) {
			output.push("  \n");
			index++;
			continue;
		}
		if (char === "\\" && /[\\*_{}[\]|!+\-^~]/.test(value[index + 1] ?? "")) {
			output.push(escapeMarkdown(value[++index] ?? ""));
			continue;
		}
		const end = literalEnd(value, index);
		if (end !== null && value.startsWith("{{", index)) {
			output.push(markdownCodeSpan(value.slice(index + 2, end - 2)));
			index = end - 1;
			continue;
		}
		if (end !== null && char === "[") {
			const link = value.slice(index + 1, end - 1);
			const separator = link.search(/(?<!\\)\|/);
			const target = (separator < 0 ? link : link.slice(separator + 1)).trim();
			if (/^(https?:\/\/|mailto:)/i.test(target)) {
				const label =
					separator < 0 ? escapeMarkdown(link) : jiraInlineToMarkdown(link.slice(0, separator));
				const url = target.replace(/[<>\s\\]/g, (c) => encodeURIComponent(c));
				output.push(`[${label}](${/[()]/.test(url) ? `<${url}>` : url})`);
			} else output.push(escapeMarkdown(value.slice(index, end)));
			index = end - 1;
			continue;
		}
		if (end !== null && char === "{") {
			output.push(escapeMarkdown(value.slice(index, end)));
			index = end - 1;
			continue;
		}
		const delimiter = char === "*" ? "**" : char === "_" ? "*" : char === "-" ? "~~" : null;
		if (
			delimiter &&
			!/[\w]/.test(value[index - 1] ?? "") &&
			!/[\s]/.test(value[index + 1] ?? "") &&
			value[index + 1] !== char
		) {
			const close = jiraEmphasisEnd(value, index, char);
			if (close !== null) {
				output.push(
					`${delimiter}${jiraInlineToMarkdown(value.slice(index + 1, close))}${delimiter}`,
				);
				index = close;
				continue;
			}
		}
		output.push(escapeMarkdown(char));
	}
	return output.join("");
}

function jiraTableRow(line: string): { cells: string[]; header: boolean } | null {
	const row = line.trim();
	if (!row.startsWith("|") || !row.endsWith("|")) return null;
	const cells: string[] = [];
	let cell = "";
	const start = row.startsWith("||") ? 2 : 1;
	const end = row.length - (row.endsWith("||") ? 2 : 1);
	for (let index = start; index < end; index++) {
		if (row[index] === "\\" && index + 1 < end) cell += row[index] + row[++index];
		else {
			const protectedEnd = literalEnd(row, index);
			if (protectedEnd !== null) {
				cell += row.slice(index, protectedEnd);
				index = protectedEnd - 1;
			} else if (row[index] === "|") {
				cells.push(cell.trim());
				cell = "";
				if (row[index + 1] === "|") index++;
			} else cell += row[index];
		}
	}
	cells.push(cell.trim());
	return { cells, header: start === 2 };
}

function jiraTextToMarkdown(value: string): string {
	const lines = value.split("\n");
	const output: string[] = [];
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? "";
		const table = jiraTableRow(line);
		if (table) {
			const rows = [table];
			while (index + 1 < lines.length) {
				const next = jiraTableRow(lines[index + 1] ?? "");
				if (!next) break;
				rows.push(next);
				index++;
			}
			const width = Math.max(...rows.map((row) => row.cells.length));
			const renderRow = (cells: string[]) =>
				`| ${Array.from({ length: width }, (_, column) =>
					jiraInlineToMarkdown(cells[column] ?? "").replace(/(?<!\\)\|/g, "\\|"),
				).join(" | ")} |`;
			const header = table.header ? (rows.shift()?.cells ?? []) : [];
			output.push(
				renderRow(header),
				`| ${Array(width).fill("---").join(" | ")} |`,
				...rows.map((row) => renderRow(row.cells)),
			);
			continue;
		}
		const heading = /^h([1-6])\.\s+(.*)$/.exec(line);
		const list = /^\s*([*#]+)\s+(.*)$/.exec(line);
		if (heading)
			output.push(`${"#".repeat(Number(heading[1]))} ${jiraInlineToMarkdown(heading[2] ?? "")}`);
		else if (list) {
			const markers = list[1] ?? "*";
			output.push(
				`${"   ".repeat(markers.length - 1)}${markers.endsWith("#") ? "1." : "-"} ${jiraInlineToMarkdown(list[2] ?? "")}`,
			);
		} else if (/^bq\.\s?/.test(line))
			output.push(`> ${jiraInlineToMarkdown(line.replace(/^bq\.\s?/, ""))}`);
		else if (/^-{4,}\s*$/.test(line)) output.push("---");
		else output.push(jiraInlineToMarkdown(line));
	}
	return output.join("\n");
}

/** Converts Jira wiki markup to Markdown while retaining unsupported macros as text. @internal */
export function jiraToMarkdown(markup: string | null | undefined): string {
	const value = normalizeNewlines(markup ?? "");
	const output: string[] = [];
	let cursor = 0;
	for (let index = 0; index < value.length; index++) {
		if (value[index] === "\\") {
			index++;
			continue;
		}
		const match = /^\{(code|noformat|quote)(?::([^}\n]*))?}/.exec(value.slice(index));
		if (!match || value.startsWith("{{", index)) {
			const protectedEnd = literalEnd(value, index);
			if (protectedEnd !== null) index = protectedEnd - 1;
			continue;
		}
		const start = index + match[0].length;
		const end = value.indexOf(`{${match[1]}}`, start);
		if (end < 0) continue;
		const before = jiraTextToMarkdown(value.slice(cursor, index)).replace(/^\n+|\n+$/g, "");
		if (before) output.push(before);
		const content = value.slice(start, end).replace(/^\n|\n$/g, "");
		if (match[1] === "quote")
			output.push(
				jiraToMarkdown(content)
					.split("\n")
					.map((line) => `> ${line}`)
					.join("\n"),
			);
		else {
			const params = match[2] ?? "";
			const language =
				/(?:^|\|)language=([\w+-]+)/.exec(params)?.[1] ??
				/^([\w+-]+)(?:\||$)/.exec(params)?.[1] ??
				"";
			const fence = backtickDelimiter(content, 3);
			output.push(`${fence}${language}\n${content}\n${fence}`);
		}
		cursor = end + `{${match[1]}}`.length;
		index = cursor - 1;
	}
	const after = jiraTextToMarkdown(value.slice(cursor)).replace(/^\n+|\n+$/g, "");
	if (after) output.push(after);
	return output.join("\n\n");
}
