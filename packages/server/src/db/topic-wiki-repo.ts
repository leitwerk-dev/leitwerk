import { createHash } from "node:crypto";
import type { TopicPublication, WikiPage, WikiTopic } from "@leitwerk-dev/domain";
import type { TopicWikiStore } from "@leitwerk-dev/process-sdk";
import { eq } from "drizzle-orm";
import type { LeitwerkDb } from "./database.js";
import { topicPublications, wikiPages, wikiRevisions, wikiTopics } from "./schema.js";

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

/** @internal */
export function createTopicWikiRepo(
	db: LeitwerkDb,
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
	const store: TopicWikiStore = {
		ensureTopic(input) {
			const id = digest(input.key);
			const topic = { ...input, id };
			if (JSON.stringify(store.getTopic(id)) === JSON.stringify(topic)) return topic;
			db.insert(wikiTopics)
				.values({ id, key: input.key, data: JSON.stringify(topic) })
				.onConflictDoUpdate({ target: wikiTopics.id, set: { data: JSON.stringify(topic) } })
				.run();
			changed(id);
			return topic;
		},
		getTopic(id) {
			const row = db.select().from(wikiTopics).where(eq(wikiTopics.id, id)).get();
			return row ? JSON.parse(row.data) : null;
		},
		listTopics() {
			return db
				.select()
				.from(wikiTopics)
				.all()
				.map((row) => JSON.parse(row.data) as WikiTopic);
		},
		listPages(topicId) {
			const topic = store.getTopic(topicId);
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
				if (!store.getTopic(input.topicId)) throw new Error("Unknown wiki topic");
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
				if (current)
					for (const dependent of store.listPages(input.topicId))
						if (dependent.links.includes(input.id))
							storePage({
								...dependent,
								status: "needs_revalidation",
								revision: dependent.revision + 1,
								updatedAt: next.updatedAt,
							});
				return next;
			});
			changed(input.topicId);
			return page;
		},
		deletePage(topicId, pageId, expectedRevision, actor) {
			db.transaction(() => {
				const current = rawPage(topicId, pageId);
				if (!current || current.deleted || current.revision !== expectedRevision)
					throw new Error("Wiki revision conflict; refresh before deleting");
				storePage({
					...current,
					markdown: "",
					applicability: "",
					evidence: [],
					deleted: true,
					revision: current.revision + 1,
					updatedAt: new Date().toISOString(),
					instanceId: actor,
					turnRecordId: "",
				});
				for (const page of store.listPages(topicId))
					if (page.links.includes(pageId))
						storePage({
							...page,
							status: "needs_revalidation",
							revision: page.revision + 1,
							updatedAt: new Date().toISOString(),
						});
			});
			changed(topicId);
		},
		publication(key) {
			const row = db.select().from(topicPublications).where(eq(topicPublications.key, key)).get();
			return row ? JSON.parse(row.data) : null;
		},
		publicationByExternalId(externalId) {
			const row = db
				.select()
				.from(topicPublications)
				.where(eq(topicPublications.externalId, externalId))
				.get();
			return row ? JSON.parse(row.data) : null;
		},
		reservePublication(input) {
			return (
				Number(
					db
						.insert(topicPublications)
						.values({
							key: input.key,
							topicId: input.topicId,
							externalId: null,
							data: JSON.stringify(input),
						})
						.onConflictDoNothing()
						.run().changes,
				) === 1
			);
		},
		finishPublication(key, externalId, url) {
			const current = store.publication(key);
			if (!current || (current.externalId && current.externalId !== externalId))
				throw new Error("Publication receipt conflict");
			const receipt: TopicPublication = { ...current, externalId, url };
			db.update(topicPublications)
				.set({ externalId, data: JSON.stringify(receipt) })
				.where(eq(topicPublications.key, key))
				.run();
		},
		releaseRejectedPublication(key) {
			const current = store.publication(key);
			if (current?.externalId) throw new Error("Cannot release a published ticket");
			db.delete(topicPublications).where(eq(topicPublications.key, key)).run();
		},
		markPublicationTriggered(key) {
			const current = store.publication(key);
			if (!current?.externalId)
				throw new Error("Ticket receipt is required before triggering changes");
			db.update(topicPublications)
				.set({ data: JSON.stringify({ ...current, triggered: true }) })
				.where(eq(topicPublications.key, key))
				.run();
		},
	};
	return store;
}
