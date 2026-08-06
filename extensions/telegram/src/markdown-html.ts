import { parseManagedResultImagePath } from "@leitwerk-dev/worker-protocol";
import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import { type DefaultTreeAdapterMap, parseFragment } from "parse5";

const TELEGRAM_HARD_LIMIT = 4096;
const DEFAULT_TELEGRAM_SOFT_LIMIT = 3900;
const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tg:"]);
const TELEGRAM_INLINE_TAGS = new Map<string, "b" | "i" | "u" | "s">([
	["b", "b"],
	["strong", "b"],
	["i", "i"],
	["em", "i"],
	["u", "u"],
	["ins", "u"],
	["s", "s"],
	["strike", "s"],
	["del", "s"],
]);
const BLOCK_TAGS = new Set([
	"article",
	"aside",
	"blockquote",
	"body",
	"dd",
	"div",
	"dl",
	"dt",
	"figcaption",
	"figure",
	"footer",
	"form",
	"header",
	"main",
	"nav",
	"p",
	"section",
	"table",
	"tbody",
	"td",
	"tfoot",
	"th",
	"thead",
	"tr",
]);
const HEADING_TAG_PATTERN = /^h[1-6]$/;

const markdown = new MarkdownIt("commonmark", {
	html: true,
	linkify: false,
});

export type TelegramResultVisual =
	| { kind: "image"; imageId: string; alt: string }
	| { kind: "mermaid"; source: string };

export type TelegramResultPart = { kind: "html"; html: string } | TelegramResultVisual;

markdown.renderer.rules.image = (tokens, index) => escapeTelegramHtml(tokens[index]?.content ?? "");

type Parse5Node = DefaultTreeAdapterMap["node"];
type Parse5Element = DefaultTreeAdapterMap["element"];
type Parse5TextNode = DefaultTreeAdapterMap["textNode"];

export function escapeTelegramHtml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function escapeTelegramAttribute(value: string): string {
	return escapeTelegramHtml(value).replaceAll('"', "&quot;");
}

function isElement(node: Parse5Node): node is Parse5Element {
	return "tagName" in node;
}

function isTextNode(node: Parse5Node): node is Parse5TextNode {
	return node.nodeName === "#text";
}

function clampMaxChars(maxChars: number): number {
	return Math.min(Math.max(maxChars, 1), TELEGRAM_HARD_LIMIT);
}

function normalizeLineEndings(value: string): string {
	return value.replace(/\r\n?/g, "\n").trim();
}

function attr(element: Parse5Element, name: string): string | null {
	return element.attrs.find((candidate) => candidate.name.toLowerCase() === name)?.value ?? null;
}

function safeHref(value: string | null): string | null {
	if (!value) return null;
	try {
		const parsed = new URL(value);
		return SAFE_LINK_PROTOCOLS.has(parsed.protocol) ? value : null;
	} catch {
		return null;
	}
}

function renderChildren(element: Pick<Parse5Element, "childNodes">): string {
	return element.childNodes.map(renderNode).join("");
}

function collectText(node: Parse5Node): string {
	if (isTextNode(node)) return node.value;
	if (!isElement(node)) return "";
	if (node.tagName.toLowerCase() === "br") return "\n";
	return node.childNodes.map(collectText).join("");
}

function withTrailingNewline(value: string): string {
	const trimmed = value.trimEnd();
	return trimmed ? `${trimmed}\n` : "";
}

function renderNode(node: Parse5Node): string {
	if (isTextNode(node)) return escapeTelegramHtml(node.value);
	if (!isElement(node)) return "";

	const tagName = node.tagName.toLowerCase();
	if (tagName === "script" || tagName === "style") return "";
	if (tagName === "br") return "\n";
	if (tagName === "hr") return "\n—\n";
	if (tagName === "img") return escapeTelegramHtml(attr(node, "alt") ?? attr(node, "title") ?? "");
	if (tagName === "pre") {
		return withTrailingNewline(
			`<pre><code>${escapeTelegramHtml(collectText(node).replace(/\n$/, ""))}</code></pre>`,
		);
	}
	if (tagName === "code") return `<code>${escapeTelegramHtml(collectText(node))}</code>`;
	if (tagName === "a") {
		const children = renderChildren(node);
		const href = safeHref(attr(node, "href"));
		return href ? `<a href="${escapeTelegramAttribute(href)}">${children}</a>` : children;
	}
	const inlineTag = TELEGRAM_INLINE_TAGS.get(tagName);
	if (inlineTag) return `<${inlineTag}>${renderChildren(node)}</${inlineTag}>`;
	if (HEADING_TAG_PATTERN.test(tagName))
		return withTrailingNewline(`<b>${renderChildren(node)}</b>`);
	if (tagName === "li") return withTrailingNewline(`• ${renderChildren(node).trim()}`);
	if (tagName === "ul" || tagName === "ol") return withTrailingNewline(renderChildren(node));
	if (BLOCK_TAGS.has(tagName)) return withTrailingNewline(renderChildren(node));
	return renderChildren(node);
}

function normalizeTelegramHtml(html: string): string {
	return parseFragment(html).childNodes.map(renderNode).join("").trim();
}

export function telegramHtmlToPlainText(html: string): string {
	return parseFragment(normalizeTelegramHtml(html)).childNodes.map(collectText).join("").trim();
}

function takeEncodedChunk(
	value: string,
	maxChars: number,
	encodeChar: (char: string) => string,
): { chunk: string; remaining: string } {
	let encoded = "";
	let rawEnd = 0;
	let lastBoundary: { rawEnd: number; encodedEnd: number } | null = null;

	for (const char of value) {
		const encodedChar = encodeChar(char);
		if (encoded.length + encodedChar.length > maxChars) break;
		encoded += encodedChar;
		rawEnd += char.length;
		if (/\s/u.test(char)) lastBoundary = { rawEnd, encodedEnd: encoded.length };
	}

	if (rawEnd === value.length) return { chunk: encoded, remaining: "" };
	if (rawEnd === 0) {
		const [firstChar = ""] = value;
		return { chunk: encodeChar(firstChar), remaining: value.slice(firstChar.length) };
	}

	const split =
		lastBoundary && lastBoundary.encodedEnd >= Math.floor(maxChars * 0.5)
			? lastBoundary
			: { rawEnd, encodedEnd: encoded.length };
	return { chunk: encoded.slice(0, split.encodedEnd), remaining: value.slice(split.rawEnd) };
}

function splitEncodedText(
	value: string,
	maxChars: number,
	encodeChar: (char: string) => string,
): string[] {
	let remaining = normalizeLineEndings(value);
	if (!remaining) return [];

	const chunks: string[] = [];
	const max = clampMaxChars(maxChars);
	while (remaining) {
		const next = takeEncodedChunk(remaining, max, encodeChar);
		chunks.push(next.chunk);
		remaining = next.remaining;
	}
	return chunks;
}

export function splitPlainTelegramText(
	value: string,
	maxChars = DEFAULT_TELEGRAM_SOFT_LIMIT,
): string[] {
	return splitEncodedText(value, maxChars, (char) => char);
}

export function splitTelegramHtml(value: string, maxChars = DEFAULT_TELEGRAM_SOFT_LIMIT): string[] {
	const normalized = normalizeLineEndings(value);
	if (!normalized) return [];
	const max = clampMaxChars(maxChars);
	if (normalized.length <= max) return [normalized];

	const safeHtml = normalizeTelegramHtml(normalized);
	return safeHtml.length <= max
		? [safeHtml]
		: splitEncodedText(telegramHtmlToPlainText(safeHtml), max, escapeTelegramHtml);
}

export function renderMarkdownToTelegramHtml(markdownText: string): string {
	const normalized = normalizeLineEndings(markdownText);
	return normalized ? normalizeTelegramHtml(markdown.render(normalized)) : "";
}

function resultVisual(
	token: Token,
	context: { instanceId: string; turnRecordId: string },
): TelegramResultVisual | null {
	if (token.type === "fence" && token.info.trim().split(/\s+/, 1)[0]?.toLowerCase() === "mermaid") {
		return { kind: "mermaid", source: token.content.trim() };
	}
	if (token.type !== "image") return null;
	const image = parseManagedResultImagePath(token.attrGet("src") ?? "");
	if (
		!image ||
		image.instanceId !== context.instanceId ||
		image.turnRecordId !== context.turnRecordId
	)
		return null;
	return { kind: "image", imageId: image.imageId, alt: token.content };
}

/**
 * Extracts only top-level visual blocks. Inline and list-nested images remain
 * ordinary rendered Markdown so media delivery never has to reconstruct open
 * formatting containers around Telegram uploads.
 */
export function renderResultMarkdownForTelegram(input: {
	markdown: string;
	instanceId: string;
	turnRecordId: string;
}): TelegramResultPart[] {
	const normalized = normalizeLineEndings(input.markdown);
	if (!normalized) return [];
	const context = { instanceId: input.instanceId, turnRecordId: input.turnRecordId };
	const tokens = markdown.parse(normalized, {});
	const parts: TelegramResultPart[] = [];
	let textTokens: Token[] = [];
	const flushHtml = (): void => {
		const html = normalizeTelegramHtml(markdown.renderer.render(textTokens, markdown.options, {}));
		if (html) parts.push({ kind: "html", html });
		textTokens = [];
	};

	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (!token) continue;
		let visual = token.level === 0 ? resultVisual(token, context) : null;
		let consumed = 0;
		const inline = tokens[index + 1];
		if (
			!visual &&
			token.level === 0 &&
			token.type === "paragraph_open" &&
			inline?.type === "inline" &&
			inline.children?.length === 1 &&
			tokens[index + 2]?.type === "paragraph_close"
		) {
			visual = resultVisual(inline.children[0] as Token, context);
			if (visual?.kind === "image") consumed = 2;
			else visual = null;
		}
		if (!visual) {
			textTokens.push(token);
			continue;
		}
		flushHtml();
		parts.push(visual);
		index += consumed;
	}
	flushHtml();
	return parts;
}
