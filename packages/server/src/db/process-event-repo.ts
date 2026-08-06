import type { ProcessEvent } from "@leitwerk-dev/domain";
import { and, asc, desc, eq, gte, inArray, like, sql } from "drizzle-orm";
import type { LeitwerkDb } from "./database.js";
import { generateId, now } from "./repo-helpers.js";
import * as s from "./schema.js";

export interface CreateProcessEventInput {
	instanceId: string;
	eventType: string;
	data?: Record<string, unknown>;
}

function rowToProcessEvent(row: typeof s.processEvents.$inferSelect): ProcessEvent {
	return {
		id: row.id,
		instanceId: row.instanceId,
		eventType: row.eventType,
		data: JSON.parse(row.data) as Record<string, unknown>,
		createdAt: row.createdAt,
	};
}

export function createProcessEventRepo(db: LeitwerkDb) {
	return {
		create(input: CreateProcessEventInput): ProcessEvent {
			const id = generateId("evt");
			const ts = now();
			const values = {
				id,
				instanceId: input.instanceId,
				eventType: input.eventType,
				data: JSON.stringify(input.data ?? {}),
				createdAt: ts,
			};
			db.insert(s.processEvents).values(values).run();
			return rowToProcessEvent(values);
		},

		listByInstance(instanceId: string, limit = 100): ProcessEvent[] {
			return db
				.select()
				.from(s.processEvents)
				.where(eq(s.processEvents.instanceId, instanceId))
				.orderBy(desc(s.processEvents.createdAt))
				.limit(limit)
				.all()
				.map(rowToProcessEvent);
		},

		listByInstanceEventTypes(
			instanceId: string,
			eventTypes: readonly string[],
			limit = 100,
		): ProcessEvent[] {
			const filteredEventTypes = eventTypes.filter((eventType) => eventType.trim() !== "");
			if (filteredEventTypes.length === 0) {
				return [];
			}
			return db
				.select()
				.from(s.processEvents)
				.where(
					and(
						eq(s.processEvents.instanceId, instanceId),
						inArray(s.processEvents.eventType, filteredEventTypes),
					),
				)
				.orderBy(desc(s.processEvents.createdAt))
				.limit(limit)
				.all()
				.map(rowToProcessEvent);
		},

		listByInstanceSince(
			instanceId: string,
			sinceCreatedAt: string,
			options: { limit?: number; eventTypePrefix?: string } = {},
		): ProcessEvent[] {
			const predicates = [
				eq(s.processEvents.instanceId, instanceId),
				gte(s.processEvents.createdAt, sinceCreatedAt),
			] as const;
			const whereClause =
				typeof options.eventTypePrefix === "string" && options.eventTypePrefix.trim() !== ""
					? and(
							...predicates,
							like(s.processEvents.eventType, `${options.eventTypePrefix.trim()}%`),
						)
					: and(...predicates);
			return db
				.select()
				.from(s.processEvents)
				.where(whereClause)
				.orderBy(desc(s.processEvents.createdAt))
				.limit(options.limit ?? 100)
				.all()
				.map(rowToProcessEvent);
		},

		listByInstanceTurnRecordEventTypes(
			instanceId: string,
			turnRecordId: string,
			eventTypes: readonly string[],
		): ProcessEvent[] {
			const filteredEventTypes = eventTypes.filter((eventType) => eventType.trim() !== "");
			if (filteredEventTypes.length === 0 || turnRecordId.trim() === "") {
				return [];
			}
			return db
				.select()
				.from(s.processEvents)
				.where(
					and(
						eq(s.processEvents.instanceId, instanceId),
						inArray(s.processEvents.eventType, filteredEventTypes),
						sql`json_extract(${s.processEvents.data}, '$.turnRecordId') = ${turnRecordId}`,
					),
				)
				.orderBy(asc(s.processEvents.createdAt), asc(s.processEvents.id))
				.all()
				.map(rowToProcessEvent);
		},

		listByInstanceSinceEventTypes(
			instanceId: string,
			sinceCreatedAt: string,
			eventTypes: readonly string[],
			limit = 100,
		): ProcessEvent[] {
			const filteredEventTypes = eventTypes.filter((eventType) => eventType.trim() !== "");
			if (filteredEventTypes.length === 0) {
				return [];
			}
			return db
				.select()
				.from(s.processEvents)
				.where(
					and(
						eq(s.processEvents.instanceId, instanceId),
						gte(s.processEvents.createdAt, sinceCreatedAt),
						inArray(s.processEvents.eventType, filteredEventTypes),
					),
				)
				.orderBy(desc(s.processEvents.createdAt))
				.limit(limit)
				.all()
				.map(rowToProcessEvent);
		},
	};
}
