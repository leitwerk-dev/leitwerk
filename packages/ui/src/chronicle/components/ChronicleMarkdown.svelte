<script lang="ts">
import { renderRichMarkdownToHtml } from "../../lib/markdown.js";
import { enhanceRichMarkdown } from "../../lib/rich-markdown-elements.js";

interface Props {
	markdown: string;
	className?: string;
}

let { markdown, className = "" }: Props = $props();
</script>

<div class={`chronicle-markdown ${className}`.trim()} use:enhanceRichMarkdown={markdown}>
	{@html renderRichMarkdownToHtml(markdown)}
</div>

<style>
	.chronicle-markdown {
		max-width: 72ch;
		color: var(--chronicle-text);
		font-size: var(--type-body);
		line-height: 1.6;
		overflow-wrap: anywhere;
	}

	.chronicle-markdown :global(h1),
	.chronicle-markdown :global(h2),
	.chronicle-markdown :global(h3),
	.chronicle-markdown :global(h4),
	.chronicle-markdown :global(h5),
	.chronicle-markdown :global(h6) {
		margin: 0 0 12px;
		font-weight: 650;
		line-height: 1.24;
		letter-spacing: -0.01em;
		color: var(--chronicle-text);
	}

	.chronicle-markdown :global(h1) {
		font-size: 18px;
	}

	.chronicle-markdown :global(h2) {
		font-size: 16px;
	}

	.chronicle-markdown :global(h3) {
		font-size: 15px;
	}

	.chronicle-markdown :global(p),
	.chronicle-markdown :global(ul),
	.chronicle-markdown :global(ol),
	.chronicle-markdown :global(blockquote) {
		max-width: 72ch;
	}

	.chronicle-markdown :global(p),
	.chronicle-markdown :global(ul),
	.chronicle-markdown :global(ol),
	.chronicle-markdown :global(blockquote),
	.chronicle-markdown :global(pre),
	.chronicle-markdown :global(table) {
		margin: 0 0 10px;
	}

	.chronicle-markdown :global(ul),
	.chronicle-markdown :global(ol) {
		padding-left: 20px;
	}

	.chronicle-markdown :global(li + li) {
		margin-top: 4px;
	}

	.chronicle-markdown :global(blockquote) {
		margin-left: 0;
		padding: 12px 14px;
		border: 1px solid color-mix(in srgb, var(--chronicle-border) 84%, white 16%);
		border-radius: 12px;
		background: color-mix(in srgb, var(--chronicle-panel-muted) 74%, white 26%);
		color: var(--chronicle-text-muted);
	}

	.chronicle-markdown :global(pre) {
		padding: 12px 14px;
		border-radius: 12px;
		border: 1px solid color-mix(in srgb, var(--chronicle-border) 84%, white 16%);
		background: var(--chronicle-code-surface);
		white-space: pre-wrap;
		overflow-x: auto;
		color: var(--chronicle-text);
	}

	.chronicle-markdown :global(code) {
		font-family: var(--font-mono);
		font-size: 12px;
		background: var(--chronicle-code-inline);
		padding: 0.14em 0.32em;
		border-radius: 6px;
		overflow-wrap: anywhere;
		word-break: break-word;
		-webkit-box-decoration-break: clone;
		box-decoration-break: clone;
	}

	.chronicle-markdown :global(pre code) {
		background: transparent;
		padding: 0;
		font-variant-numeric: tabular-nums;
	}

	.chronicle-markdown :global(a) {
		color: var(--chronicle-link);
		text-decoration: none;
	}

	.chronicle-markdown :global(a:hover) {
		text-decoration: underline;
	}

	.chronicle-markdown :global([data-result-image]) {
		display: block;
		margin: 0 0 10px;
	}

	.chronicle-markdown :global([data-result-image] a) {
		display: block;
	}

	.chronicle-markdown :global([data-result-image] img) {
		display: block;
		max-width: 100%;
		height: auto;
		border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
		border-radius: 12px;
	}

	.chronicle-markdown :global(hr) {
		border: 0;
		border-top: 1px solid var(--chronicle-border);
		margin: 12px 0;
	}

	.chronicle-markdown :global(table) {
		width: 100%;
		border-collapse: collapse;
		font-size: var(--type-body-sm);
		font-variant-numeric: tabular-nums;
	}

	.chronicle-markdown :global(th),
	.chronicle-markdown :global(td) {
		padding: 8px 10px;
		border: 1px solid var(--chronicle-border);
		text-align: left;
		vertical-align: top;
	}

	.chronicle-markdown :global(th) {
		font-weight: 600;
		background: color-mix(in srgb, var(--chronicle-panel-muted) 78%, white 22%);
	}

	.chronicle-markdown :global(*:last-child) {
		margin-bottom: 0;
	}
</style>
