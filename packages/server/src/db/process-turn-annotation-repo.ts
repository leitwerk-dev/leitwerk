import type { ProcessTurnAnnotation, TurnAnnotationReference } from "@leitwerk-dev/domain";
import { parseTurnAnnotationReferences } from "@leitwerk-dev/domain";
import { and, asc, eq, sql } from "drizzle-orm";
import type { SQLiteUpdateSetSource } from "drizzle-orm/sqlite-core";
import type { LeitwerkDb } from "./database.js";
import { type HistoryWindow, historyWindow } from "./history-window.js";
import { generateId, now, parseJsonRecord } from "./repo-helpers.js";
import * as s from "./schema.js";

/** @internal */
export interface CreateProcessTurnAnnotationInput {
	/** @internal */
	id?: string;
	/** @internal */
	instanceId: string;
	/** @internal */
	annotationType: string;
	/** Null means append-only and therefore not addressable via upsert key. @internal */
	annotationKey?: string | null;
	/** @internal */
	references?: readonly TurnAnnotationReference[];
	/** @internal */
	payload?: Record<string, unknown>;
	/** @internal */
	createdAt?: string;
	/** @internal */
	updatedAt?: string;
}

/** @internal */
export interface UpdateProcessTurnAnnotationInput {
	/** @internal */
	annotationType?: string;
	/** Null means append-only and therefore not addressable via upsert key. @internal */
	annotationKey?: string | null;
	/** @internal */
	references?: readonly TurnAnnotationReference[];
	/** @internal */
	payload?: Record<string, unknown>;
	/** @internal */
	updatedAt?: string;
}

function parseReferences(value: string): TurnAnnotationReference[] {
	try {
		return parseTurnAnnotationReferences(JSON.parse(value));
	} catch {
		return [];
	}
}

function rowToProcessTurnAnnotation(
	row: typeof s.turnAnnotations.$inferSelect,
): ProcessTurnAnnotation {
	return {
		id: row.id,
		instanceId: row.instanceId,
		annotationType: row.annotationType,
		annotationKey: row.annotationKey ?? null,
		references: parseReferences(row.referencesJson),
		payload: parseJsonRecord(row.payloadJson) ?? {},
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

/** @internal */
export function createProcessTurnAnnotationRepo(db: LeitwerkDb) {
	const list = (instanceId: string, window: HistoryWindow | undefined, compact: boolean) =>
		db
			.select({
				id: s.turnAnnotations.id,
				instanceId: s.turnAnnotations.instanceId,
				annotationType: s.turnAnnotations.annotationType,
				annotationKey: s.turnAnnotations.annotationKey,
				referencesJson: s.turnAnnotations.referencesJson,
				payloadJson: compact
					? sql<string>`json_remove(${s.turnAnnotations.payloadJson}, '$.event')`
					: s.turnAnnotations.payloadJson,
				createdAt: s.turnAnnotations.createdAt,
				updatedAt: s.turnAnnotations.updatedAt,
			})
			.from(s.turnAnnotations)
			.where(
				and(
					eq(s.turnAnnotations.instanceId, instanceId),
					historyWindow(s.turnAnnotations.createdAt, window),
				),
			)
			.orderBy(asc(s.turnAnnotations.createdAt))
			.all()
			.map(rowToProcessTurnAnnotation);
	return {
		/** @internal */
		create(input: CreateProcessTurnAnnotationInput): ProcessTurnAnnotation {
			const id = input.id ?? generateId("tan");
			const createdAt = input.createdAt ?? now();
			const updatedAt = input.updatedAt ?? createdAt;
			const values = {
				id,
				instanceId: input.instanceId,
				annotationType: input.annotationType,
				annotationKey: input.annotationKey ?? null,
				referencesJson: JSON.stringify(input.references ?? []),
				payloadJson: JSON.stringify(input.payload ?? {}),
				createdAt,
				updatedAt,
			};
			db.insert(s.turnAnnotations).values(values).run();
			return rowToProcessTurnAnnotation(values);
		},

		/** @internal */
		getById(id: string): ProcessTurnAnnotation | null {
			const row = db.select().from(s.turnAnnotations).where(eq(s.turnAnnotations.id, id)).get();
			return row ? rowToProcessTurnAnnotation(row) : null;
		},

		/** @internal */
		findByKey(instanceId: string, annotationKey: string): ProcessTurnAnnotation | null {
			const key = annotationKey.trim();
			if (key.length === 0) {
				return null;
			}
			const row = db
				.select()
				.from(s.turnAnnotations)
				.where(
					and(
						eq(s.turnAnnotations.instanceId, instanceId),
						eq(s.turnAnnotations.annotationKey, key),
					),
				)
				.get();
			return row ? rowToProcessTurnAnnotation(row) : null;
		},

		/** @internal */
		listByInstance(instanceId: string, window?: HistoryWindow): ProcessTurnAnnotation[] {
			return list(instanceId, window, false);
		},

		/** Keep presentation and observation fields without the raw source event. @internal */
		listForTimeline(instanceId: string, window?: HistoryWindow): ProcessTurnAnnotation[] {
			return list(instanceId, window, true);
		},

		/** @internal */
		update(id: string, input: UpdateProcessTurnAnnotationInput): ProcessTurnAnnotation | null {
			const setValues: SQLiteUpdateSetSource<typeof s.turnAnnotations> = {
				updatedAt: input.updatedAt ?? now(),
				annotationType: input.annotationType,
				annotationKey: input.annotationKey,
			};
			if (input.references !== undefined)
				setValues.referencesJson = JSON.stringify(input.references);
			if (input.payload !== undefined) setValues.payloadJson = JSON.stringify(input.payload);

			db.update(s.turnAnnotations).set(setValues).where(eq(s.turnAnnotations.id, id)).run();
			return this.getById(id);
		},

		/** @internal */
		delete(id: string): boolean {
			const result = db.delete(s.turnAnnotations).where(eq(s.turnAnnotations.id, id)).run();
			return result.changes > 0;
		},
	};
}
