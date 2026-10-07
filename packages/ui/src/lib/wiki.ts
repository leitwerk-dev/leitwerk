import { createWikiClient, type WikiUiHost } from "@leitwerk-dev/wiki/ui";
import ExternalLink from "../components/ExternalLink.svelte";
import PageHeader from "../components/PageHeader.svelte";
import { ApiResponseError, apiResponseError, requestJson } from "./http-client.js";
import { renderMarkdownToHtml } from "./markdown.js";
import { followLink, navigate } from "./router.svelte.js";

/** @internal */
export function notifyWikiUpdated(topicId: string): void {
	window.dispatchEvent(new CustomEvent("leitwerk:wiki-updated", { detail: { topicId } }));
}

/** @internal */
export function onWikiUpdated(listener: (topicId: string) => void): () => void {
	const handler = (event: Event) =>
		listener((event as CustomEvent<{ topicId: string }>).detail.topicId);
	window.addEventListener("leitwerk:wiki-updated", handler);
	return () => window.removeEventListener("leitwerk:wiki-updated", handler);
}

const client = createWikiClient((input) =>
	requestJson({ ...input, error: apiResponseError(input.error) }),
);
/** @internal */
export const wikiUiHost: WikiUiHost = {
	client,
	renderMarkdownToHtml,
	followLink,
	navigate,
	onWikiUpdated,
	PageHeader,
	ExternalLink,
	errorStatus: (error) => (error instanceof ApiResponseError ? error.status : undefined),
};
