import { and, desc, eq } from "drizzle-orm";
import type { LeitwerkDb } from "./database.js";
import { generateId, now } from "./repo-helpers.js";
import * as s from "./schema.js";

/** @internal */
export interface TicketDestinationRecent {
	/** @internal */
	id: string;
	/** @internal */
	actorKey: string;
	/** @internal */
	toolName: string;
	/** @internal */
	destinationId: string;
	/** @internal */
	createdAt: string;
	/** @internal */
	updatedAt: string;
}

function map(row: typeof s.ticketDestinationRecents.$inferSelect): TicketDestinationRecent {
	return { ...row };
}

/** @internal */
export function createTicketDestinationRecentRepo(db: LeitwerkDb) {
	return {
		/** @internal */
		list(actorKey: string, toolName: string, limit = 5): TicketDestinationRecent[] {
			return db
				.select()
				.from(s.ticketDestinationRecents)
				.where(
					and(
						eq(s.ticketDestinationRecents.actorKey, actorKey),
						eq(s.ticketDestinationRecents.toolName, toolName),
					),
				)
				.orderBy(
					desc(s.ticketDestinationRecents.updatedAt),
					desc(s.ticketDestinationRecents.createdAt),
				)
				.limit(limit)
				.all()
				.map(map);
		},

		/** @internal */
		record(input: {
			/** @internal */
			actorKey: string;
			/** @internal */
			toolName: string;
			/** @internal */
			destinationId: string;
			/** @internal */
			limit?: number;
		}): TicketDestinationRecent {
			const match = and(
				eq(s.ticketDestinationRecents.actorKey, input.actorKey),
				eq(s.ticketDestinationRecents.toolName, input.toolName),
				eq(s.ticketDestinationRecents.destinationId, input.destinationId),
			);
			const existing = db.select().from(s.ticketDestinationRecents).where(match).get();
			const updatedAt = now();
			let result: TicketDestinationRecent;
			if (existing) {
				db.update(s.ticketDestinationRecents).set({ updatedAt }).where(match).run();
				result = { ...map(existing), updatedAt };
			} else {
				const row = {
					id: generateId("tdr"),
					actorKey: input.actorKey,
					toolName: input.toolName,
					destinationId: input.destinationId,
					createdAt: updatedAt,
					updatedAt,
				};
				db.insert(s.ticketDestinationRecents).values(row).run();
				result = row;
			}
			const stale = db
				.select({ id: s.ticketDestinationRecents.id })
				.from(s.ticketDestinationRecents)
				.where(
					and(
						eq(s.ticketDestinationRecents.actorKey, input.actorKey),
						eq(s.ticketDestinationRecents.toolName, input.toolName),
					),
				)
				.orderBy(
					desc(s.ticketDestinationRecents.updatedAt),
					desc(s.ticketDestinationRecents.createdAt),
				)
				.all()
				.slice(input.limit ?? 5);
			for (const entry of stale) {
				db.delete(s.ticketDestinationRecents)
					.where(eq(s.ticketDestinationRecents.id, entry.id))
					.run();
			}
			return result;
		},
	};
}
