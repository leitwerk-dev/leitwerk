import type { PublicationReceipt, PublicationStore } from "@leitwerk-dev/external-writes";
import { eq } from "drizzle-orm";
import type { LeitwerkDb } from "./database.js";
import { topicPublications } from "./schema.js";

/** @internal */
export function createPublicationRepo(db: LeitwerkDb): PublicationStore {
	const store: PublicationStore = {
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
			const receipt: PublicationReceipt = { ...current, externalId, url };
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
