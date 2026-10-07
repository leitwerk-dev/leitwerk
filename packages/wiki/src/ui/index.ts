import type { Component, Snippet } from "svelte";
import type { WikiPage, WikiPageContent, WikiTopic } from "../model.js";

/** Authenticated JSON transport supplied by the application. @internal */
export type WikiRequest = <T extends object>(input: {
	/** @internal */ path: string;
	/** @internal */ init?: RequestInit;
	/** @internal */ malformed: string;
	/** @internal */ error: string;
}) => Promise<T>;

/** @internal */
export interface WikiTopicsSnapshot {
	/** @internal */
	topics: WikiTopic[];
}
/** @internal */
export interface WikiTopicSnapshot {
	/** @internal */
	topic: WikiTopic;
	/** @internal */
	pages: WikiPage[];
}
/** @internal */
export interface WikiHistorySnapshot {
	/** @internal */
	revisions: WikiPage[];
}
/** @internal */
export interface WikiSavedPage {
	/** @internal */
	page: WikiPage;
}
/** @internal */
export interface WikiDeleted {
	/** @internal */
	deleted: boolean;
}
/** @internal */
export interface WikiClient {
	/** @internal */
	fetchWikiTopics(): Promise<WikiTopicsSnapshot>;
	/** @internal */
	fetchWikiTopic(topicId: string): Promise<WikiTopicSnapshot>;
	/** @internal */
	fetchWikiHistory(topicId: string, pageId: string): Promise<WikiHistorySnapshot>;
	/** @internal */
	deleteWikiPage(page: WikiPage): Promise<WikiDeleted>;
	/** @internal */
	editWikiPage(page: WikiPage, content: WikiPageContent): Promise<WikiSavedPage>;
	/** @internal */
	deleteWikiGroup(topic: WikiTopic): Promise<WikiDeleted>;
}

/** @internal */
export function createWikiClient(request: WikiRequest): WikiClient {
	const topicPath = (id: string) => `/api/wiki/topics/${encodeURIComponent(id)}`;
	const pagePath = (topicId: string, pageId: string) =>
		`${topicPath(topicId)}/pages/${encodeURIComponent(pageId)}`;
	return {
		/** @internal */
		fetchWikiTopics: () =>
			request<WikiTopicsSnapshot>({
				path: "/api/wiki/topics",
				malformed: "Malformed wiki index",
				error: "Couldn't load solution wikis",
			}),
		/** @internal */
		fetchWikiTopic: (topicId: string) =>
			request<WikiTopicSnapshot>({
				path: topicPath(topicId),
				malformed: "Malformed wiki",
				error: "Couldn't load this wiki",
			}),
		/** @internal */
		fetchWikiHistory: (topicId: string, pageId: string) =>
			request<WikiHistorySnapshot>({
				path: `${pagePath(topicId, pageId)}/history`,
				malformed: "Malformed revision history",
				error: "Couldn't load entry history",
			}),
		/** @internal */
		deleteWikiPage: (page: WikiPage) =>
			request<WikiDeleted>({
				path: `${pagePath(page.topicId, page.id)}?revision=${page.revision}`,
				init: { method: "DELETE" },
				malformed: "Malformed deletion response",
				error: "Couldn't delete this entry; refresh and try again",
			}),
		/** @internal */
		editWikiPage: (page: WikiPage, content: WikiPageContent) =>
			request<WikiSavedPage>({
				path: pagePath(page.topicId, page.id),
				init: {
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ ...content, expectedRevision: page.revision }),
				},
				malformed: "Malformed edit response",
				error: "Couldn't save this entry. Your draft has been kept.",
			}),
		/** @internal */
		deleteWikiGroup: (topic: WikiTopic) =>
			request<WikiDeleted>({
				path: `${topicPath(topic.id)}?revision=${topic.revision ?? 1}`,
				init: { method: "DELETE" },
				malformed: "Malformed group deletion response",
				error: "Couldn't delete this wiki group; refresh and try again",
			}),
	};
}

/** Stable application services supplied when mounting the wiki view. @internal */
export interface WikiUiHost {
	/** @internal */ client: WikiClient;
	/** Must return sanitized HTML. @internal */ renderMarkdownToHtml(markdown: string): string;
	/** @internal */ navigate(path: string): void;
	/** @internal */ followLink(event: MouseEvent, path: string): void;
	/** @internal */ errorStatus(error: unknown): number | undefined;
	/** @internal */ onWikiUpdated(listener: (topicId: string) => void): () => void;
	/** @internal */ PageHeader: Component<{
		/** @internal */ title: string;
		/** @internal */ subtitle?: string | null;
		/** @internal */ actions?: Snippet;
	}>;
	/** @internal */ ExternalLink: Component<{
		/** @internal */
		href: string;
		/** @internal */
		label: string;
	}>;
}
