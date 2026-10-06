import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-sqlite";
import type { WikiPage, WikiTopic } from "../model.js";
import type { TopicWikiStore } from "../store.js";
import { wikiPages, wikiRevisions, wikiTopics } from "./schema.js";

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

/** @internal */
export function createTopicWikiRepo(
	db: ReturnType<typeof drizzle>,
	changed: (topicId: string) => void = () => {},
): TopicWikiStore {
	function rawPage(topicId: string, pageId: string): WikiPage | null {
		const row = db
			.select()
			.from(wikiPages)
			.where(eq(wikiPages.id, digest(JSON.stringify([topicId, pageId]))))
			.get();
		return row ? JSON.parse(row.data) : null;
	}
	function storePage(page: WikiPage): void {
		const id = digest(JSON.stringify([page.topicId, page.id]));
		const data = JSON.stringify(page);
		db.insert(wikiPages)
			.values({ id, topicId: page.topicId, data })
			.onConflictDoUpdate({ target: wikiPages.id, set: { data } })
			.run();
		db.insert(wikiRevisions)
			.values({ id: `${id}:${page.revision}`, pageId: id, data })
			.run();
	}
	function storeTopic(topic: WikiTopic): void {
		db.insert(wikiTopics)
			.values({ id: topic.id, key: topic.key, data: JSON.stringify(topic) })
			.onConflictDoUpdate({ target: wikiTopics.id, set: { data: JSON.stringify(topic) } })
			.run();
	}
	function bumpTopic(topicId: string): void {
		const topic = store.getTopic(topicId);
		if (!topic) throw new Error("Unknown wiki topic");
		storeTopic({ ...topic, revision: (topic.revision ?? 1) + 1 });
	}
	function tombstone(current: WikiPage, actor: string, turnRecordId = ""): WikiPage {
		return {
			...current,
			markdown: "",
			applicability: "",
			evidence: [],
			deleted: true,
			revision: current.revision + 1,
			updatedAt: new Date().toISOString(),
			instanceId: actor,
			turnRecordId,
			updatedBy: undefined,
		};
	}
	function invalidateDependents(topicId: string, pageId: string, updatedAt: string): void {
		for (const page of store.listPages(topicId))
			if (page.links.includes(pageId))
				storePage({
					...page,
					status: "needs_revalidation",
					revision: page.revision + 1,
					updatedAt,
				});
	}
	const store: TopicWikiStore = {
		ensureTopic(input) {
			const id = digest(input.key);
			const current = store.getTopic(id);
			if (current?.deleted) return current;
			const topic = { ...input, id, revision: current?.revision ?? 1, deleted: false };
			if (JSON.stringify(current) === JSON.stringify(topic)) return topic;
			if (current) topic.revision++;
			storeTopic(topic);
			changed(id);
			return topic;
		},
		getTopic(id) {
			const row = db.select().from(wikiTopics).where(eq(wikiTopics.id, id)).get();
			if (!row) return null;
			const topic = JSON.parse(row.data) as WikiTopic;
			return { ...topic, revision: topic.revision ?? 1, deleted: topic.deleted ?? false };
		},
		listTopics() {
			return db
				.select()
				.from(wikiTopics)
				.all()
				.map((row) => {
					const topic = JSON.parse(row.data) as WikiTopic;
					return { ...topic, revision: topic.revision ?? 1, deleted: topic.deleted ?? false };
				})
				.filter((topic) => !topic.deleted);
		},
		listPages(topicId) {
			const topic = store.getTopic(topicId);
			if (!topic || topic.deleted) return [];
			const pages = db
				.select()
				.from(wikiPages)
				.where(eq(wikiPages.topicId, topicId))
				.all()
				.map((row) => JSON.parse(row.data) as WikiPage)
				.filter((page) => !page.deleted);
			const ids = new Set(pages.map((page) => page.id));
			const stale = new Set(
				pages
					.filter(
						(page) =>
							page.sourceRevision !== topic?.sourceRevision ||
							page.status === "needs_revalidation" ||
							page.links.some((link) => !ids.has(link)),
					)
					.map((page) => page.id),
			);
			let previousSize = -1;
			while (previousSize !== stale.size) {
				previousSize = stale.size;
				for (const page of pages)
					if (page.links.some((link) => stale.has(link))) stale.add(page.id);
			}
			return pages.map((page) => ({
				...page,
				status: stale.has(page.id) ? "needs_revalidation" : page.status,
			}));
		},
		readPage(topicId, pageId) {
			return store.listPages(topicId).find((page) => page.id === pageId) ?? null;
		},
		history(topicId, pageId) {
			if (!store.readPage(topicId, pageId)) return [];
			return db
				.select()
				.from(wikiRevisions)
				.where(eq(wikiRevisions.pageId, digest(JSON.stringify([topicId, pageId]))))
				.all()
				.map((row) => JSON.parse(row.data) as WikiPage)
				.sort((left, right) => right.revision - left.revision);
		},
		savePage(input, expectedRevision) {
			const page = db.transaction(() => {
				const current = rawPage(input.topicId, input.id);
				if (current?.deleted || (current?.revision ?? 0) !== expectedRevision)
					throw new Error("Wiki revision conflict or deleted page; refresh before editing");
				const topic = store.getTopic(input.topicId);
				if (!topic || topic.deleted) throw new Error("Wiki group unavailable or deleted");
				for (const link of input.links)
					if (!store.readPage(input.topicId, link) || link === input.id)
						throw new Error("Wiki links must reference another current page in this topic");
				const next: WikiPage = {
					...input,
					revision: expectedRevision + 1,
					updatedAt: new Date().toISOString(),
					deleted: false,
				};
				storePage(next);
				if (current) invalidateDependents(input.topicId, input.id, next.updatedAt);
				bumpTopic(input.topicId);
				return next;
			});
			changed(input.topicId);
			return page;
		},
		deletePage(topicId, pageId, expectedRevision, actor, turnRecordId) {
			db.transaction(() => {
				const current = rawPage(topicId, pageId);
				if (!current || current.deleted || current.revision !== expectedRevision)
					throw new Error("Wiki revision conflict; refresh before deleting");
				storePage(tombstone(current, actor, turnRecordId));
				invalidateDependents(topicId, pageId, new Date().toISOString());
				bumpTopic(topicId);
			});
			changed(topicId);
		},
		deleteTopic(topicId, expectedRevision, actor, turnRecordId) {
			db.transaction(() => {
				const topic = store.getTopic(topicId);
				if (!topic || topic.deleted || topic.revision !== expectedRevision)
					throw new Error("Wiki group revision conflict; refresh before deleting");
				const pages = db.select().from(wikiPages).where(eq(wikiPages.topicId, topicId)).all();
				for (const row of pages) {
					const page = JSON.parse(row.data) as WikiPage;
					if (!page.deleted) storePage(tombstone(page, actor, turnRecordId));
				}
				storeTopic({
					...topic,
					deleted: true,
					revision: expectedRevision + 1,
					deletion: { actor, turnRecordId: turnRecordId ?? "", at: new Date().toISOString() },
				});
			});
			changed(topicId);
		},
	};
	return store;
}
