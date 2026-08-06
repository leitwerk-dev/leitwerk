import { describe, expect, it } from "vitest";
import {
	escapeTelegramHtml,
	renderMarkdownToTelegramHtml,
	renderResultMarkdownForTelegram,
	splitPlainTelegramText,
	splitTelegramHtml,
} from "./markdown-html.js";

describe("Telegram HTML markdown rendering", () => {
	it("escapes unsafe HTML text", () => {
		expect(escapeTelegramHtml("<script>&</script>")).toBe("&lt;script&gt;&amp;&lt;/script&gt;");
	});

	it("renders common markdown constructs to Telegram-supported HTML", () => {
		const rendered = renderMarkdownToTelegramHtml(
			[
				"## Plan",
				"Use **safe** output and `code`.",
				"See [docs](https://example.com/docs).",
				"```",
				"<unsafe>",
				"```",
			].join("\n"),
		);

		expect(rendered).toContain("<b>Plan</b>");
		expect(rendered).toContain("<b>safe</b>");
		expect(rendered).toContain("<code>code</code>");
		expect(rendered).toContain("<a href=");
		expect(rendered).toContain("<pre><code>&lt;unsafe&gt;</code></pre>");
	});

	it("escapes link hrefs and emits only Telegram-supported link attributes", () => {
		const rendered = renderMarkdownToTelegramHtml(
			'See [a link](https://example.com/search?q=a&lang=en "title").',
		);
		expect(rendered).toContain('<a href="https://example.com/search?q=a&amp;lang=en">a link</a>');
		expect(rendered).not.toContain("title=");
	});

	it("normalizes raw HTML block and line-break tags to Telegram newlines", () => {
		const rendered = renderMarkdownToTelegramHtml(
			"<div>First<br>Second</div><p>Third</p><h2>Fourth</h2>",
		);
		expect(rendered).toContain("First\nSecond");
		expect(rendered).toContain("Third");
		expect(rendered).toContain("<b>Fourth</b>");
		expect(rendered).not.toContain("&lt;br");
		expect(rendered).not.toContain("<br");
	});

	it("drops unsupported raw HTML tags while preserving safe text content", () => {
		const rendered = renderMarkdownToTelegramHtml(
			"<section data-x='1'>safe <span>text</span></section><script>bad()</script>",
		);
		expect(rendered).toContain("safe text");
		expect(rendered).not.toContain("section");
		expect(rendered).not.toContain("span");
		expect(rendered).not.toContain("bad()");
	});

	it("canonicalizes supported raw HTML tags and removes unsafe attributes", () => {
		const rendered = renderMarkdownToTelegramHtml(
			"<strong class='x'>bold</strong> <em>em</em> <ins>u</ins> <del>s</del>",
		);
		expect(rendered).toContain("<b>bold</b>");
		expect(rendered).toContain("<i>em</i>");
		expect(rendered).toContain("<u>u</u>");
		expect(rendered).toContain("<s>s</s>");
		expect(rendered).not.toContain("class=");
	});

	it("keeps link text but removes unsafe href values", () => {
		const rendered = renderMarkdownToTelegramHtml(
			"<a href='javascript:alert(1)' onclick='bad()'>unsafe link</a>",
		);
		expect(rendered).toContain("unsafe link");
		expect(rendered).not.toContain("javascript:");
		expect(rendered).not.toContain("onclick");
	});

	it("does not treat inline code as raw HTML", () => {
		const rendered = renderMarkdownToTelegramHtml("Use `<br>` syntax.");
		expect(rendered).toContain("<code>&lt;br&gt;</code>");
	});

	it("does not apply bold formatting inside inline code", () => {
		const rendered = renderMarkdownToTelegramHtml("Use `**literal**` syntax.");
		expect(rendered).toContain("<code>**literal**</code>");
		expect(rendered).not.toContain("<code><b>literal</b></code>");
	});

	it("renders images as escaped alt text instead of unsupported image tags", () => {
		const rendered = renderMarkdownToTelegramHtml("![safe <alt>](https://example.com/a.png)");
		expect(rendered).toContain("safe &lt;alt&gt;");
		expect(rendered).not.toContain("<img");
	});

	it("extracts only turn-correlated managed images and Mermaid diagrams", () => {
		const parts = renderResultMarkdownForTelegram({
			instanceId: "prc_1",
			turnRecordId: "trn_1",
			markdown: [
				"Result text",
				"![Evidence](/api/processes/prc_1/turn-records/trn_1/result-images/img_1.png)",
				"![Other turn](/api/processes/prc_1/turn-records/trn_2/result-images/img_2.png)",
				"```mermaid\nflowchart LR\n  A --> B\n```",
			].join("\n\n"),
		});

		const html = parts
			.filter((part) => part.kind === "html")
			.map((part) => part.html)
			.join("\n");
		const visuals = parts.filter((part) => part.kind !== "html");
		expect(html).toContain("Result text");
		expect(html).toContain("Other turn");
		expect(html).not.toContain("Evidence");
		expect(html).not.toContain("flowchart");
		expect(visuals).toEqual([
			{ kind: "image", imageId: "img_1.png", alt: "Evidence" },
			{ kind: "mermaid", source: "flowchart LR\n  A --> B" },
		]);
		expect(parts).toEqual([
			{ kind: "html", html: "Result text" },
			{ kind: "image", imageId: "img_1.png", alt: "Evidence" },
			{ kind: "html", html: "Other turn" },
			{ kind: "mermaid", source: "flowchart LR\n  A --> B" },
		]);
	});

	it("leaves non-block images in ordinary rendered Markdown", () => {
		const image = "![Evidence](/api/processes/prc_1/turn-records/trn_1/result-images/img_1.png)";
		const parts = renderResultMarkdownForTelegram({
			instanceId: "prc_1",
			turnRecordId: "trn_1",
			markdown: `**before ${image} after**\n\n- listed before ${image} listed after`,
		});

		expect(parts).toHaveLength(1);
		expect(parts[0]).toMatchObject({ kind: "html" });
		const html = parts[0]?.kind === "html" ? parts[0].html : "";
		expect(html).toContain("<b>before Evidence after</b>");
		expect(html).toContain("• listed before Evidence listed after");
	});

	it("renders long markdown without truncating it", () => {
		const rendered = renderMarkdownToTelegramHtml("<&".repeat(100));
		expect(rendered.length).toBeGreaterThan(20);
		expect(rendered).toContain("&lt;&amp;");
		expect(rendered).not.toContain("…");
	});

	it("preserves supported markup in long rendered markdown", () => {
		const rendered = renderMarkdownToTelegramHtml(
			`See [docs](https://example.com/docs). ${"more ".repeat(20)}`,
		);
		expect(rendered).toContain('<a href="https://example.com/docs">docs</a>');
	});

	it("splits long HTML into safe Telegram chunks", () => {
		const chunks = splitTelegramHtml(`<b>Result</b>\n${"<&>".repeat(40)}`, 20);
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.every((chunk) => chunk.length <= 20)).toBe(true);
		expect(chunks.join("")).toContain("&lt;&amp;&gt;");
		expect(chunks.every((chunk) => !/&(?:l|lt|g|gt|a|am|amp)$/.test(chunk))).toBe(true);
	});

	it("falls back to escaped visible text for oversized HTML", () => {
		const chunks = splitTelegramHtml(
			`Intro ${"alpha ".repeat(12)}<a href="https://example.com/search?q=a&amp;lang=en">open docs</a> ${"omega ".repeat(12)}`,
			90,
		);
		const combined = chunks.join("");
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.every((chunk) => chunk.length <= 90)).toBe(true);
		expect(combined).toContain("open docs");
		expect(combined).not.toContain("<a href=");
	});

	it("splits long plain text without dropping content", () => {
		const text = "alpha beta gamma delta";
		const chunks = splitPlainTelegramText(text, 10);
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.every((chunk) => chunk.length <= 10)).toBe(true);
		expect(chunks.join("")).toBe(text);
	});
});
