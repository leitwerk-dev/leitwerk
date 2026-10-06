import { sqliteTable, text } from "drizzle-orm/sqlite-core";

/** @internal */
export const wikiTopics = sqliteTable("wiki_topics", {
	/** @internal */
	id: text("id").primaryKey(),
	/** @internal */
	key: text("key").notNull(),
	/** @internal */
	data: text("data").notNull(),
});

/** @internal */
export const wikiPages = sqliteTable("wiki_pages", {
	/** @internal */
	id: text("id").primaryKey(),
	/** @internal */
	topicId: text("topic_id")
		.notNull()
		.references(() => wikiTopics.id),
	/** @internal */
	data: text("data").notNull(),
});

/** @internal */
export const wikiRevisions = sqliteTable("wiki_revisions", {
	/** @internal */
	id: text("id").primaryKey(),
	/** @internal */
	pageId: text("page_id")
		.notNull()
		.references(() => wikiPages.id),
	/** @internal */
	data: text("data").notNull(),
});
