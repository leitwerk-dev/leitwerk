import type { MappedItem, MappedRun, MappedRunStatus, TurnId } from "@leitwerk-dev/domain";
import { and, asc, eq } from "drizzle-orm";
import type { LeitwerkDb } from "./database.js";
import { now } from "./repo-helpers.js";
import * as s from "./schema.js";

/** @internal */
export interface CreateMappedRunInput {
	/** @internal */
	id: string;
	/** @internal */
	instanceId: string;
	/** @internal */
	turnId: TurnId;
	/** @internal */
	status: MappedRunStatus;
	/** @internal */
	items: ReadonlyArray<Pick<MappedItem, "itemIndex" | "itemKey" | "label" | "itemJson">>;
}

/** @internal */
export interface CompleteMappedItemInput {
	/** @internal */
	runId: string;
	/** @internal */
	itemIndex: number;
	/** @internal */
	outcome: string;
	/** @internal */
	resultJson: string;
	/** @internal */
	turnRecordId: string;
}

function mapRun(row: typeof s.mappedLlmRuns.$inferSelect): MappedRun {
	return {
		id: row.id,
		instanceId: row.instanceId,
		turnId: row.turnId,
		status: row.status as MappedRunStatus,
		itemCount: row.itemCount,
		nextIndex: row.nextIndex,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

function mapItem(row: typeof s.mappedLlmItems.$inferSelect): MappedItem {
	return {
		runId: row.runId,
		instanceId: row.instanceId,
		itemIndex: row.itemIndex,
		itemKey: row.itemKey,
		label: row.label,
		itemJson: row.itemJson,
		status: row.status as MappedItem["status"],
		outcome: row.outcome ?? null,
		resultJson: row.resultJson ?? null,
		turnRecordId: row.turnRecordId ?? null,
		completedAt: row.completedAt ?? null,
	};
}

/** @internal */
export function createMappedLlmRunRepo(db: LeitwerkDb) {
	return {
		/** @internal */
		create(input: CreateMappedRunInput): MappedRun {
			const ts = now();
			const run = {
				id: input.id,
				instanceId: input.instanceId,
				turnId: input.turnId,
				status: input.status,
				itemCount: input.items.length,
				nextIndex: input.status === "completed" ? input.items.length : 0,
				createdAt: ts,
				updatedAt: ts,
			};
			db.insert(s.mappedLlmRuns).values(run).run();
			for (const item of input.items) {
				db.insert(s.mappedLlmItems)
					.values({
						runId: input.id,
						instanceId: input.instanceId,
						itemIndex: item.itemIndex,
						itemKey: item.itemKey,
						label: item.label,
						itemJson: item.itemJson,
						status: "pending",
					})
					.run();
			}
			return mapRun(run);
		},
		/** @internal */
		getById(id: string): MappedRun | null {
			const row = db.select().from(s.mappedLlmRuns).where(eq(s.mappedLlmRuns.id, id)).get();
			return row ? mapRun(row) : null;
		},
		/** @internal */
		getActiveByInstance(instanceId: string): MappedRun | null {
			const row = db
				.select()
				.from(s.mappedLlmRuns)
				.where(
					and(eq(s.mappedLlmRuns.instanceId, instanceId), eq(s.mappedLlmRuns.status, "active")),
				)
				.get();
			return row ? mapRun(row) : null;
		},
		/** @internal */
		listByInstance(instanceId: string): MappedRun[] {
			return db
				.select()
				.from(s.mappedLlmRuns)
				.where(eq(s.mappedLlmRuns.instanceId, instanceId))
				.orderBy(asc(s.mappedLlmRuns.createdAt))
				.all()
				.map(mapRun);
		},
		/** @internal */
		listItems(runId: string): MappedItem[] {
			return db
				.select()
				.from(s.mappedLlmItems)
				.where(eq(s.mappedLlmItems.runId, runId))
				.orderBy(asc(s.mappedLlmItems.itemIndex))
				.all()
				.map(mapItem);
		},
		/** @internal */
		listItemsByInstance(instanceId: string): MappedItem[] {
			return db
				.select()
				.from(s.mappedLlmItems)
				.where(eq(s.mappedLlmItems.instanceId, instanceId))
				.all()
				.map(mapItem);
		},
		/** @internal */
		getItem(runId: string, itemIndex: number): MappedItem | null {
			const row = db
				.select()
				.from(s.mappedLlmItems)
				.where(and(eq(s.mappedLlmItems.runId, runId), eq(s.mappedLlmItems.itemIndex, itemIndex)))
				.get();
			return row ? mapItem(row) : null;
		},
		/**
		 * Records one item result and advances the run. Fails unless the item is the
		 * run's current pending item, so a replayed outcome cannot complete it twice.
		 * @internal
		 */
		completeItem(input: CompleteMappedItemInput): MappedRun {
			const run = this.getById(input.runId);
			if (!run || run.status !== "active" || run.nextIndex !== input.itemIndex) {
				throw new Error(`Mapped item ${input.itemIndex} of run '${input.runId}' is not current`);
			}
			const ts = now();
			const updated = db
				.update(s.mappedLlmItems)
				.set({
					status: "completed",
					outcome: input.outcome,
					resultJson: input.resultJson,
					turnRecordId: input.turnRecordId,
					completedAt: ts,
				})
				.where(
					and(
						eq(s.mappedLlmItems.runId, input.runId),
						eq(s.mappedLlmItems.itemIndex, input.itemIndex),
						eq(s.mappedLlmItems.status, "pending"),
					),
				)
				.run();
			if (updated.changes !== 1) {
				throw new Error(`Mapped item ${input.itemIndex} of run '${input.runId}' is not pending`);
			}
			const nextIndex = input.itemIndex + 1;
			db.update(s.mappedLlmRuns)
				.set({
					nextIndex,
					status: nextIndex === run.itemCount ? "completed" : "active",
					updatedAt: ts,
				})
				.where(eq(s.mappedLlmRuns.id, input.runId))
				.run();
			return this.getById(input.runId) as MappedRun;
		},
		/** @internal */
		abortActiveByInstance(instanceId: string): number {
			return Number(
				db
					.update(s.mappedLlmRuns)
					.set({ status: "aborted", updatedAt: now() })
					.where(
						and(eq(s.mappedLlmRuns.instanceId, instanceId), eq(s.mappedLlmRuns.status, "active")),
					)
					.run().changes,
			);
		},
	};
}

/** @internal */
export type MappedLlmRunRepo = ReturnType<typeof createMappedLlmRunRepo>;
