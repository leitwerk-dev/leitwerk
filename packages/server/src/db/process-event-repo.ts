import type { ProcessEvent } from "@leitwerk-dev/domain";
import { applyEventToCompactTurnSummary, emptyCompactTurnSummary } from "@leitwerk-dev/protocol";
import { and, asc, desc, eq, gte, inArray, like, type SQL, sql } from "drizzle-orm";
import type { LeitwerkDb } from "./database.js";
import { generateId, now } from "./repo-helpers.js";
import * as s from "./schema.js";
import { createTurnSummaryRepo } from "./turn-summary-repo.js";

export interface CreateProcessEventInput {
	instanceId: string;
	eventType: string;
	data?: Record<string, unknown>;
}

function rowToProcessEvent(row: typeof s.processEvents.$inferSelect): ProcessEvent {
	return {
		id: row.id,
		eventSequence: row.eventSequence,
		instanceId: row.instanceId,
		eventType: row.eventType,
		data: JSON.parse(row.data) as Record<string, unknown>,
		createdAt: row.createdAt,
	};
}

export function createProcessEventRepo(db: LeitwerkDb) {
	const summaries = createTurnSummaryRepo(db);
	const listNewest = (where: SQL | undefined, limit: number): ProcessEvent[] =>
		db
			.select()
			.from(s.processEvents)
			.where(where)
			.orderBy(desc(s.processEvents.eventSequence))
			.limit(limit)
			.all()
			.map(rowToProcessEvent);
	return {
		create(input: CreateProcessEventInput): ProcessEvent {
			const id = generateId("evt");
			const ts = now();
			const values = {
				eventSequence:
					(db
						.select({ sequence: sql<number>`coalesce(max(${s.processEvents.eventSequence}), 0)` })
						.from(s.processEvents)
						.get()?.sequence ?? 0) + 1,
				turnRecordId: typeof input.data?.turnRecordId === "string" ? input.data.turnRecordId : null,
				id,
				instanceId: input.instanceId,
				eventType: input.eventType,
				data: JSON.stringify(input.data ?? {}),
				createdAt: ts,
			};
			db.transaction(() => {
				db.insert(s.processEvents).values(values).run();
				if (values.turnRecordId) {
					summaries.put(
						input.instanceId,
						values.turnRecordId,
						applyEventToCompactTurnSummary(
							summaries.get(values.turnRecordId) ?? emptyCompactTurnSummary(),
							{
								eventType: input.eventType,
								data: input.data ?? {},
								createdAt: ts,
								eventSequence: values.eventSequence,
							},
						),
					);
				}
			});
			return rowToProcessEvent(values);
		},

		latestSequence(instanceId: string): number {
			return (
				db
					.select({ sequence: s.processEvents.eventSequence })
					.from(s.processEvents)
					.where(eq(s.processEvents.instanceId, instanceId))
					.orderBy(desc(s.processEvents.eventSequence))
					.limit(1)
					.get()?.sequence ?? 0
			);
		},
		listByTurnRecord(instanceId: string, turnRecordId: string): ProcessEvent[] {
			return db
				.select()
				.from(s.processEvents)
				.where(
					and(
						eq(s.processEvents.instanceId, instanceId),
						eq(s.processEvents.turnRecordId, turnRecordId),
					),
				)
				.orderBy(asc(s.processEvents.eventSequence))
				.all()
				.map(rowToProcessEvent);
		},
		latestByTurnRecordEventType(
			instanceId: string,
			turnRecordId: string,
			eventType: string,
		): ProcessEvent | null {
			const row = db
				.select()
				.from(s.processEvents)
				.where(
					and(
						eq(s.processEvents.instanceId, instanceId),
						eq(s.processEvents.turnRecordId, turnRecordId),
						eq(s.processEvents.eventType, eventType),
					),
				)
				.orderBy(desc(s.processEvents.eventSequence))
				.limit(1)
				.get();
			return row ? rowToProcessEvent(row) : null;
		},
		summary(turnRecordId: string) {
			return summaries.get(turnRecordId);
		},
		listByInstance(instanceId: string, limit = 100): ProcessEvent[] {
			return listNewest(eq(s.processEvents.instanceId, instanceId), limit);
		},

		listByInstanceEventTypes(
			instanceId: string,
			eventTypes: readonly string[],
			limit = 100,
		): ProcessEvent[] {
			const filteredEventTypes = [
				...new Set(eventTypes.filter((eventType) => eventType.trim() !== "")),
			];
			if (filteredEventTypes.length === 0) {
				return [];
			}
			// With IN + ORDER BY, SQLite may scan the instance's entire event stream.
			// Equality on each type uses the type/sequence index and bounds every read.
			const events = filteredEventTypes.flatMap((eventType) =>
				listNewest(
					and(eq(s.processEvents.instanceId, instanceId), eq(s.processEvents.eventType, eventType)),
					limit,
				),
			);
			events.sort((a, b) => (b.eventSequence ?? 0) - (a.eventSequence ?? 0));
			return limit < 0 ? events : events.slice(0, limit);
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
						eq(s.processEvents.turnRecordId, turnRecordId),
					),
				)
				.orderBy(asc(s.processEvents.eventSequence))
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
