import { normalizeMarkdownLineEndings } from "@leitwerk-dev/domain";
import { parseManagedResultImagePath } from "@leitwerk-dev/worker-protocol/worker-result-image";
import createDOMPurify from "dompurify";
import MarkdownIt from "markdown-it";

function createMarkdownRenderer(options: { rich: boolean }): MarkdownIt {
	const renderer = new MarkdownIt({
		html: true,
		linkify: false,
		breaks: false,
		xhtmlOut: true,
	});
	if (!options.rich) return renderer;

	const escapeHtml = renderer.utils.escapeHtml;
	renderer.renderer.rules.image = (tokens, index) => {
		const token = tokens[index];
		const src = token?.attrGet("src") ?? "";
		if (!parseManagedResultImagePath(src)) return escapeHtml(token?.content ?? "");
		return `<span data-result-image="${escapeHtml(src)}" data-alt="${escapeHtml(token?.content ?? "")}"></span>`;
	};
	const defaultFence = renderer.renderer.rules.fence;
	renderer.renderer.rules.fence = (tokens, index, options, env, self) => {
		const token = tokens[index];
		if (token?.info.trim().split(/\s+/, 1)[0]?.toLowerCase() === "mermaid") {
			return `<div data-mermaid-source><pre><code>${escapeHtml(token.content)}</code></pre></div>`;
		}
		return defaultFence
			? defaultFence(tokens, index, options, env, self)
			: self.renderToken(tokens, index, options);
	};
	return renderer;
}

const markdownRenderer = createMarkdownRenderer({ rich: false });
const richMarkdownRenderer = createMarkdownRenderer({ rich: true });

function sanitizeRenderedHtml(renderedHtml: string): string {
	const htmlSanitizer = createDOMPurify(globalThis.window);
	if (!htmlSanitizer.isSupported || typeof htmlSanitizer.sanitize !== "function") {
		throw new Error("renderMarkdownToHtml requires a DOM-capable environment for DOMPurify");
	}

	const sanitizedHtml = htmlSanitizer.sanitize(renderedHtml, {
		FORBID_TAGS: [
			"audio",
			"embed",
			"iframe",
			"img",
			"object",
			"picture",
			"source",
			"track",
			"video",
		],
		FORBID_ATTR: ["poster", "srcset"],
	});
	const template = globalThis.document.createElement("template");
	template.innerHTML = sanitizedHtml;
	for (const link of template.content.querySelectorAll("a[href]")) {
		if (link.getAttribute("href")?.trim().startsWith("#")) {
			link.removeAttribute("target");
			continue;
		}
		link.setAttribute("target", "_blank");
		link.setAttribute("rel", "noopener noreferrer");
	}
	return template.innerHTML;
}

export function renderMarkdownToHtml(markdown: string): string {
	return sanitizeRenderedHtml(markdownRenderer.render(normalizeMarkdownLineEndings(markdown), {}));
}

export function renderRichMarkdownToHtml(markdown: string): string {
	return sanitizeRenderedHtml(
		richMarkdownRenderer.render(normalizeMarkdownLineEndings(markdown), {}),
	);
}

export function markdownToPlainText(markdown: string): string {
	return normalizeMarkdownLineEndings(markdown)
		.replace(/<br\s*\/?>/gi, " ")
		.replace(/<\/?[^>]+>/g, " ")
		.replace(/```([\s\S]*?)```/g, (_match, code: string) => code.trim())
		.replace(/^#{1,6}\s+/gm, "")
		.replace(/^\s*[-*+]\s+/gm, "")
		.replace(/^\s*\d+\.\s+/gm, "")
		.replace(/^\s*>\s?/gm, "")
		.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/__([^_]+)__/g, "$1")
		.replace(/\*([^*]+)\*/g, "$1")
		.replace(/_([^_]+)_/g, "$1")
		.replace(/\s+/g, " ")
		.trim();
}

export function truncateText(value: string, maxLength: number): string {
	if (value.length <= maxLength) {
		return value;
	}
	return `${value.slice(0, maxLength).trimEnd()}…`;
}
