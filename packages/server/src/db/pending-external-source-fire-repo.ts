import { and, asc, eq } from "drizzle-orm";
import type { SQLiteUpdateSetSource } from "drizzle-orm/sqlite-core";
import type { LeitwerkDb } from "./database.js";
import { generateId, now } from "./repo-helpers.js";
import * as s from "./schema.js";

/** @internal */
export interface PendingExternalSourceFire {
	/** @internal */
	id: string;
	/** @internal */
	instanceId: string;
	/** @internal */
	armingId: string;
	/** @internal */
	turnId: string;
	/** @internal */
	externalActionId: string;
	/** @internal */
	sourceKind: string;
	/** @internal */
	input: Record<string, unknown>;
	/** @internal */
	event: Record<string, unknown>;
	/** @internal */
	mergeKey: string | null;
	/** @internal */
	queuedCount: number;
	/** @internal */
	createdAt: string;
	/** @internal */
	updatedAt: string;
}

/** @internal */
export interface CreatePendingExternalSourceFireInput {
	/** @internal */
	instanceId: string;
	/** @internal */
	armingId: string;
	/** @internal */
	turnId: string;
	/** @internal */
	externalActionId: string;
	/** @internal */
	sourceKind?: string;
	/** @internal */
	input?: Record<string, unknown>;
	/** @internal */
	event?: Record<string, unknown>;
	/** @internal */
	mergeKey?: string | null;
	/** @internal */
	queuedCount?: number;
}

/** @internal */
export interface UpdatePendingExternalSourceFireInput {
	/** @internal */
	input?: Record<string, unknown>;
	/** @internal */
	event?: Record<string, unknown>;
	/** @internal */
	queuedCount?: number;
}

function parseRecord(json: string): Record<string, unknown> {
	const value = JSON.parse(json) as unknown;
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function rowToPendingExternalSourceFire(
	row: typeof s.pendingExternalSourceFires.$inferSelect,
): PendingExternalSourceFire {
	return {
		id: row.id,
		instanceId: row.instanceId,
		armingId: row.armingId,
		turnId: row.turnId,
		externalActionId: row.externalActionId,
		sourceKind: row.sourceKind,
		input: parseRecord(row.inputJson),
		event: parseRecord(row.eventJson),
		mergeKey: row.mergeKey,
		queuedCount: row.queuedCount,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

/** @internal */
export function createPendingExternalSourceFireRepo(db: LeitwerkDb) {
	return {
		/** @internal */
		create(input: CreatePendingExternalSourceFireInput): PendingExternalSourceFire {
			const ts = now();
			const values = {
				id: generateId("pxf"),
				instanceId: input.instanceId,
				armingId: input.armingId,
				turnId: input.turnId,
				externalActionId: input.externalActionId,
				sourceKind: input.sourceKind ?? "",
				inputJson: JSON.stringify(input.input ?? {}),
				eventJson: JSON.stringify(input.event ?? {}),
				mergeKey: input.mergeKey ?? null,
				queuedCount: input.queuedCount ?? 1,
				createdAt: ts,
				updatedAt: ts,
			};
			db.insert(s.pendingExternalSourceFires).values(values).run();
			return rowToPendingExternalSourceFire(values);
		},

		/** @internal */
		listByInstance(instanceId: string): PendingExternalSourceFire[] {
			return db
				.select()
				.from(s.pendingExternalSourceFires)
				.where(eq(s.pendingExternalSourceFires.instanceId, instanceId))
				.orderBy(asc(s.pendingExternalSourceFires.createdAt))
				.all()
				.map(rowToPendingExternalSourceFire);
		},

		/** @internal */
		getByMergeKey(
			instanceId: string,
			armingId: string,
			mergeKey: string,
		): PendingExternalSourceFire | null {
			const row = db
				.select()
				.from(s.pendingExternalSourceFires)
				.where(
					and(
						eq(s.pendingExternalSourceFires.instanceId, instanceId),
						eq(s.pendingExternalSourceFires.armingId, armingId),
						eq(s.pendingExternalSourceFires.mergeKey, mergeKey),
					),
				)
				.get();
			return row ? rowToPendingExternalSourceFire(row) : null;
		},

		/** @internal */
		update(
			id: string,
			input: UpdatePendingExternalSourceFireInput,
		): PendingExternalSourceFire | null {
			const setValues: SQLiteUpdateSetSource<typeof s.pendingExternalSourceFires> = {
				updatedAt: now(),
				queuedCount: input.queuedCount,
			};
			if (input.input !== undefined) setValues.inputJson = JSON.stringify(input.input);
			if (input.event !== undefined) setValues.eventJson = JSON.stringify(input.event);

			db.update(s.pendingExternalSourceFires)
				.set(setValues)
				.where(eq(s.pendingExternalSourceFires.id, id))
				.run();
			const row = db
				.select()
				.from(s.pendingExternalSourceFires)
				.where(eq(s.pendingExternalSourceFires.id, id))
				.get();
			return row ? rowToPendingExternalSourceFire(row) : null;
		},

		/** @internal */
		delete(id: string): boolean {
			const result = db
				.delete(s.pendingExternalSourceFires)
				.where(eq(s.pendingExternalSourceFires.id, id))
				.run();
			return result.changes > 0;
		},
	};
}
