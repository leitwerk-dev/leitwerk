import { and, asc, eq } from "drizzle-orm";
import type { LeitwerkDb } from "./database.js";
import { generateId, now } from "./repo-helpers.js";
import * as s from "./schema.js";

export interface PendingExternalSourceFire {
	id: string;
	instanceId: string;
	armingId: string;
	turnId: string;
	externalActionId: string;
	sourceKind: string;
	input: Record<string, unknown>;
	event: Record<string, unknown>;
	mergeKey: string | null;
	queuedCount: number;
	createdAt: string;
	updatedAt: string;
}

export interface CreatePendingExternalSourceFireInput {
	instanceId: string;
	armingId: string;
	turnId: string;
	externalActionId: string;
	sourceKind?: string;
	input?: Record<string, unknown>;
	event?: Record<string, unknown>;
	mergeKey?: string | null;
	queuedCount?: number;
}

export interface UpdatePendingExternalSourceFireInput {
	input?: Record<string, unknown>;
	event?: Record<string, unknown>;
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

export function createPendingExternalSourceFireRepo(db: LeitwerkDb) {
	return {
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

		listByInstance(instanceId: string): PendingExternalSourceFire[] {
			return db
				.select()
				.from(s.pendingExternalSourceFires)
				.where(eq(s.pendingExternalSourceFires.instanceId, instanceId))
				.orderBy(asc(s.pendingExternalSourceFires.createdAt))
				.all()
				.map(rowToPendingExternalSourceFire);
		},

		listByInstanceAndArming(instanceId: string, armingId: string): PendingExternalSourceFire[] {
			return db
				.select()
				.from(s.pendingExternalSourceFires)
				.where(
					and(
						eq(s.pendingExternalSourceFires.instanceId, instanceId),
						eq(s.pendingExternalSourceFires.armingId, armingId),
					),
				)
				.orderBy(asc(s.pendingExternalSourceFires.createdAt))
				.all()
				.map(rowToPendingExternalSourceFire);
		},

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

		update(
			id: string,
			input: UpdatePendingExternalSourceFireInput,
		): PendingExternalSourceFire | null {
			const setValues: Record<string, unknown> = { updatedAt: now() };
			if (input.input !== undefined) setValues.inputJson = JSON.stringify(input.input);
			if (input.event !== undefined) setValues.eventJson = JSON.stringify(input.event);
			if (input.queuedCount !== undefined) setValues.queuedCount = input.queuedCount;
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

		delete(id: string): boolean {
			const result = db
				.delete(s.pendingExternalSourceFires)
				.where(eq(s.pendingExternalSourceFires.id, id))
				.run();
			return result.changes > 0;
		},

		deleteByInstanceAndArming(instanceId: string, armingId: string): number {
			const result = db
				.delete(s.pendingExternalSourceFires)
				.where(
					and(
						eq(s.pendingExternalSourceFires.instanceId, instanceId),
						eq(s.pendingExternalSourceFires.armingId, armingId),
					),
				)
				.run();
			return result.changes;
		},
	};
}
