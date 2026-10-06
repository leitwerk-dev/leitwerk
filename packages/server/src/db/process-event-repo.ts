import type { ProcessEvent } from "@leitwerk-dev/domain";
import { applyEventToCompactTurnSummary, emptyCompactTurnSummary } from "@leitwerk-dev/protocol";
import { and, asc, desc, eq, gte, inArray, like, type SQL, sql } from "drizzle-orm";
import type { LeitwerkDb } from "./database.js";
import { generateId, now } from "./repo-helpers.js";
import * as s from "./schema.js";
import { createTurnSummaryRepo } from "./turn-summary-repo.js";

/** @internal */
export interface CreateProcessEventInput {
	/** @internal */
	instanceId: string;
	/** @internal */
	eventType: string;
	/** @internal */
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

/** @internal */
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
		/** Timeline facts without embedded process state or provider responses. @internal */
		listUiSnapshotEvents(instanceId: string, turnRecordIds: readonly string[]): ProcessEvent[] {
			const newestIds = (where: SQL | undefined, limit: number) =>
				db
					.select({ id: s.processEvents.id, sequence: s.processEvents.eventSequence })
					.from(s.processEvents)
					.where(where)
					.orderBy(desc(s.processEvents.eventSequence))
					.limit(limit)
					.all();
			// Select identities before loading payloads. Most candidates are discarded
			// by the combined limit, and one provider response can be megabytes.
			const candidates = [
				"worker_capacity_queued",
				"lifecycle_parked",
				"worker_failed",
				"external_trigger_listener_armed",
				"external_source_armed",
				"external_trigger_failed",
				"external_source_failed",
				"external_trigger_consumed",
				"external_source_consumed",
			].flatMap((eventType) =>
				newestIds(
					and(eq(s.processEvents.instanceId, instanceId), eq(s.processEvents.eventType, eventType)),
					40,
				),
			);
			candidates.sort((left, right) => right.sequence - left.sequence);
			const selected = candidates.slice(0, 40);
			for (const turnRecordId of turnRecordIds) {
				for (const eventType of ["turn.progress", "turn_outcome_recorded"]) {
					selected.push(
						...newestIds(
							and(
								eq(s.processEvents.instanceId, instanceId),
								eq(s.processEvents.turnRecordId, turnRecordId),
								eq(s.processEvents.eventType, eventType),
							),
							1,
						),
					);
				}
			}
			const ids = [...new Set(selected.map((event) => event.id))];
			if (ids.length === 0) return [];
			const data = s.processEvents.data;
			return db
				.select({
					id: s.processEvents.id,
					eventSequence: s.processEvents.eventSequence,
					turnRecordId: s.processEvents.turnRecordId,
					instanceId: s.processEvents.instanceId,
					eventType: s.processEvents.eventType,
					createdAt: s.processEvents.createdAt,
					data: sql<string>`json_object(
						'turnRecordId', json_extract(${data}, '$.turnRecordId'),
						'turnId', json_extract(${data}, '$.turnId'),
						'outcome', json_extract(${data}, '$.outcome'),
						'params', json_object(
							'summary', json_extract(${data}, '$.params.summary'),
							'planMarkdown', json_extract(${data}, '$.params.planMarkdown'),
							'reviewMarkdown', json_extract(${data}, '$.params.reviewMarkdown'),
							'feedback', json_extract(${data}, '$.params.feedback')),
						'report', json_extract(${data}, '$.report'),
						'revision', json_extract(${data}, '$.revision'),
						'startRecordId', json_extract(${data}, '$.startRecordId'),
						'reason', json_extract(${data}, '$.reason'),
						'message', json_extract(${data}, '$.message'),
						'errorCode', json_extract(${data}, '$.errorCode'),
						'errorClass', json_extract(${data}, '$.errorClass'),
						'armingId', json_extract(${data}, '$.armingId'),
						'trigger', json_extract(${data}, '$.trigger'),
						'path', json_extract(${data}, '$.path'),
						'pollInterval', json_extract(${data}, '$.pollInterval'),
						'provider', json_object(
							'path', json_extract(${data}, '$.provider.path'),
							'pollInterval', json_extract(${data}, '$.provider.pollInterval'))
					)`,
				})
				.from(s.processEvents)
				.where(inArray(s.processEvents.id, ids))
				.orderBy(asc(s.processEvents.createdAt), asc(s.processEvents.id))
				.all()
				.map(rowToProcessEvent);
		},
		/** @internal */
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

		/** @internal */
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
		/** @internal */
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
		/** @internal */
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
		/** @internal */
		summary(turnRecordId: string) {
			return summaries.get(turnRecordId);
		},
		/** @internal */
		listByInstance(instanceId: string, limit = 100): ProcessEvent[] {
			return listNewest(eq(s.processEvents.instanceId, instanceId), limit);
		},

		/** @internal */
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

		/** @internal */
		listByInstanceSince(
			instanceId: string,
			sinceCreatedAt: string,
			options: {
				/** @internal */
				limit?: number;
				/** @internal */
				eventTypePrefix?: string;
			} = {},
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

		/** @internal */
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

		/** @internal */
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
