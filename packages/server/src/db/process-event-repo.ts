import type { ProcessEvent } from "@leitwerk-dev/domain";
import { and, asc, desc, eq, gte, inArray, like, type SQL, sql } from "drizzle-orm";
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
	const listNewest = (where: SQL | undefined, limit: number): ProcessEvent[] =>
		db
			.select()
			.from(s.processEvents)
			.where(where)
			.orderBy(desc(s.processEvents.createdAt))
			.limit(limit)
			.all()
			.map(rowToProcessEvent);
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
			return listNewest(eq(s.processEvents.instanceId, instanceId), limit);
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
			return listNewest(
				and(
					eq(s.processEvents.instanceId, instanceId),
					inArray(s.processEvents.eventType, filteredEventTypes),
				),
				limit,
			);
		},

		listByInstanceSince(
			instanceId: string,
			sinceCreatedAt: string,
			options: { limit?: number; eventTypePrefix?: string } = {},
		): ProcessEvent[] {
			const prefix =
				typeof options.eventTypePrefix === "string" ? options.eventTypePrefix.trim() : "";
			return listNewest(
				and(
					eq(s.processEvents.instanceId, instanceId),
					gte(s.processEvents.createdAt, sinceCreatedAt),
					prefix ? like(s.processEvents.eventType, `${prefix}%`) : undefined,
				),
				options.limit ?? 100,
			);
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
			return listNewest(
				and(
					eq(s.processEvents.instanceId, instanceId),
					gte(s.processEvents.createdAt, sinceCreatedAt),
					inArray(s.processEvents.eventType, filteredEventTypes),
				),
				limit,
			);
		},
	};
}
