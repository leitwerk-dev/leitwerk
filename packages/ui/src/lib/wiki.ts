import type { WikiPage, WikiTopic } from "@leitwerk-dev/domain";
import { apiResponseError, requestJson } from "./http-client.js";

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

/** @internal */
export function fetchWikiTopics(): Promise<{ topics: WikiTopic[] }> {
	return requestJson({
		path: "/api/wiki/topics",
		malformed: "Malformed wiki index",
		error: apiResponseError("Couldn't load solution wikis"),
	});
}

/** @internal */
export function fetchWikiTopic(topicId: string): Promise<{ topic: WikiTopic; pages: WikiPage[] }> {
	return requestJson({
		path: `/api/wiki/topics/${encodeURIComponent(topicId)}`,
		malformed: "Malformed wiki",
		error: apiResponseError("Couldn't load this wiki"),
	});
}

/** @internal */
export function fetchWikiHistory(
	topicId: string,
	pageId: string,
): Promise<{ revisions: WikiPage[] }> {
	return requestJson({
		path: `/api/wiki/topics/${encodeURIComponent(topicId)}/pages/${encodeURIComponent(pageId)}/history`,
		malformed: "Malformed revision history",
		error: apiResponseError("Couldn't load entry history"),
	});
}

/** @internal */
export function deleteWikiPage(page: WikiPage): Promise<{ deleted: boolean }> {
	return requestJson({
		path: `/api/wiki/topics/${encodeURIComponent(page.topicId)}/pages/${encodeURIComponent(page.id)}?revision=${page.revision}`,
		init: { method: "DELETE" },
		malformed: "Malformed deletion response",
		error: apiResponseError("Couldn't delete this entry; refresh and try again"),
	});
}
