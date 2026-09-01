// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
	markdownToPlainText,
	renderMarkdownToHtml,
	renderRichMarkdownToHtml,
	truncateText,
} from "./markdown.js";

function normalizeHtml(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

describe("renderMarkdownToHtml", () => {
	it("renders headings, lists, and paragraphs as HTML", () => {
		const html = normalizeHtml(
			renderMarkdownToHtml("## Result\n\n- Ship it\n- Add tests\n\nReady to merge."),
		);

		expect(html).toContain("<h2>Result</h2>");
		expect(html).toContain("<ul> <li>Ship it</li> <li>Add tests</li> </ul>");
		expect(html).toContain("<p>Ready to merge.</p>");
	});

	it("lets markdown-it render raw html and lets DOMPurify sanitize it", () => {
		const html = normalizeHtml(
			renderMarkdownToHtml("Hello <script>alert(1)</script> **done** [link](https://example.com)"),
		);

		expect(html).toContain("<strong>done</strong>");
		expect(html).toContain(
			'<a href="https://example.com" target="_blank" rel="noopener noreferrer">link</a>',
		);
		expect(html).not.toContain("<script>");
		expect(html).not.toContain("alert(1)");
	});

	it("treats single newlines with standard markdown semantics", () => {
		const html = normalizeHtml(renderMarkdownToHtml("First line\nSecond line\nThird line"));

		expect(html).toContain("<p>First line Second line Third line</p>");
	});

	it("renders raw br tags without a custom compatibility pass", () => {
		const html = normalizeHtml(
			renderMarkdownToHtml("First line<br>Second line<br />Third line <span>bad</span>"),
		);

		expect(html).toContain("<p>First line<br>Second line<br>Third line <span>bad</span></p>");
		const paragraphCount = (html.match(/<p>/g) ?? []).length;
		expect(paragraphCount).toBe(1);
	});

	it("does not unescape br tags inside inline code", () => {
		const html = renderMarkdownToHtml("Use `<br>` literally");

		expect(html).toContain("<code>&lt;br&gt;</code>");
	});

	it("opens sanitized links in a new window", () => {
		const html = normalizeHtml(
			renderMarkdownToHtml(
				"[safe](https://example.com) [unsafe](javascript:alert(1)) [ftp](ftp://example.com) [rel](./x)",
			),
		);

		expect(html).toContain(
			'<a href="https://example.com" target="_blank" rel="noopener noreferrer">safe</a>',
		);
		expect(html).toContain("[unsafe](javascript:alert(1))");
		expect(html).toContain(
			'<a href="ftp://example.com" target="_blank" rel="noopener noreferrer">ftp</a>',
		);
		expect(html).toContain('<a href="./x" target="_blank" rel="noopener noreferrer">rel</a>');
		expect(html).not.toContain('href="javascript:alert(1)"');
	});

	it("strips resource-loading media elements from markdown output", () => {
		const html = normalizeHtml(
			renderMarkdownToHtml(
				'![diagram](https://example.com/diagram.png)<video src="https://example.com/demo.mp4"></video>',
			),
		);

		expect(html).not.toContain("<img");
		expect(html).not.toContain("<video");
	});

	it("keeps rich placeholders out of the shared plain renderer", () => {
		const managed = "/api/processes/prc_1/turn-records/trn_1/result-images/img_1.png";
		const html = renderMarkdownToHtml(
			`![Evidence](${managed})\n\n\`\`\`mermaid\nflowchart LR\n  A --> B\n\`\`\``,
		);
		expect(html).not.toContain("data-result-image");
		expect(html).not.toContain("data-mermaid-source");
		expect(html).toContain('class="language-mermaid"');
		expect(html).toContain("flowchart LR");
	});

	it("renders only exact managed result image paths as rich internal elements", () => {
		const managed = "/api/processes/prc_1/turn-records/trn_1/result-images/img_1.png";
		const html = renderRichMarkdownToHtml(
			`![Evidence](${managed})\n\n![Remote](https://example.com/x.png)`,
		);
		expect(html).toContain(`<span data-result-image="${managed}" data-alt="Evidence">`);
		expect(html).not.toContain("https://example.com/x.png");
		expect(html).not.toContain("<img");
	});

	it("turns Mermaid fences into escaped rich internal placeholders", () => {
		const html = renderRichMarkdownToHtml("```mermaid\nflowchart LR\n  A --> B\n```");
		expect(html).toContain('<div data-mermaid-source="">');
		expect(html).toContain("flowchart LR");
		expect(html).not.toContain("<svg");
	});
});

describe("markdownToPlainText", () => {
	it("collapses markdown into a single-line preview string", () => {
		expect(markdownToPlainText("## Result\n\n- Ship it\n- Add tests")).toBe(
			"Result Ship it Add tests",
		);
	});

	it("treats br tags like visible line breaks in previews", () => {
		expect(markdownToPlainText("First line<br>Second line<br />Third line")).toBe(
			"First line Second line Third line",
		);
	});
});

describe("truncateText", () => {
	it("adds an ellipsis when the preview exceeds the max length", () => {
		expect(truncateText("abcdefghijklmnopqrstuvwxyz", 10)).toBe("abcdefghij…");
		expect(truncateText("short", 10)).toBe("short");
	});
});
