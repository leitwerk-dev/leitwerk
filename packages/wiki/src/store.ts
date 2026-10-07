import type { WikiPage, WikiTopic } from "./model.js";

/** @internal */
export interface TopicWikiStore {
	/** @internal */ ensureTopic(
		input: Omit<WikiTopic, "id" | "revision" | "deleted" | "deletion">,
	): WikiTopic;
	/** @internal */ getTopic(id: string): WikiTopic | null;
	/** @internal */ listTopics(): WikiTopic[];
	/** @internal */ listPages(topicId: string): WikiPage[];
	/** @internal */ readPage(topicId: string, pageId: string): WikiPage | null;
	/** @internal */ history(topicId: string, pageId: string): WikiPage[];
	/** @internal */ savePage(
		input: Omit<WikiPage, "revision" | "updatedAt" | "deleted">,
		expectedRevision: number,
	): WikiPage;
	/** @internal */ deletePage(
		topicId: string,
		pageId: string,
		expectedRevision: number,
		actor: string,
		turnRecordId?: string,
	): void;
	/** @internal */ deleteTopic(
		topicId: string,
		expectedRevision: number,
		actor: string,
		turnRecordId?: string,
	): void;
}
