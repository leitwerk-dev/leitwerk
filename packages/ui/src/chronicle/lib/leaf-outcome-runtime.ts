import type {
	LeafOutcomeRendererMeta,
	LeafOutcomeRendererRuntime,
} from "@leitwerk-dev/process-sdk/leaf-outcome-renderer";
import { formatRelativeTime } from "../../lib/format.js";
import { renderMarkdownToHtml } from "../../lib/markdown.js";
import { getFetchImpl, resolveApiUrl } from "../../lib/runtime-config.js";

export type { LeafOutcomeRendererMeta, LeafOutcomeRendererRuntime };

function renderMarkdown(markdown: string): string {
	return renderMarkdownToHtml(markdown);
}

const runtime: LeafOutcomeRendererRuntime = {
	apiVersion: 1,
	markdown: {
		render(markdown) {
			return renderMarkdown(markdown);
		},
	},
	server: {
		resolveUrl(path) {
			return resolveApiUrl(path);
		},
		fetch(path, init) {
			return getFetchImpl()(resolveApiUrl(path), init);
		},
	},
	formatRelativeTime(iso) {
		return formatRelativeTime(iso);
	},
};

export function getLeafOutcomeRendererRuntime(): LeafOutcomeRendererRuntime {
	return runtime;
}
