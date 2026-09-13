import type {
	LeafOutcomeRendererMeta,
	LeafOutcomeRendererRuntime,
} from "@leitwerk-dev/process-sdk/leaf-outcome-renderer";
import { formatRelativeTime } from "../../lib/format.js";
import { renderMarkdownToHtml } from "../../lib/markdown.js";
import { getFetchImpl, resolveApiUrl } from "../../lib/runtime-config.js";

export type { LeafOutcomeRendererMeta, LeafOutcomeRendererRuntime };

const runtime: LeafOutcomeRendererRuntime = {
	apiVersion: 1,
	markdown: { render: renderMarkdownToHtml },
	server: {
		resolveUrl: resolveApiUrl,
		fetch(path, init) {
			return getFetchImpl()(resolveApiUrl(path), init);
		},
	},
	formatRelativeTime,
};

export function getLeafOutcomeRendererRuntime(): LeafOutcomeRendererRuntime {
	return runtime;
}
