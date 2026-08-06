import { and, desc, eq } from "drizzle-orm";
import type { LeitwerkDb } from "./database.js";
import { generateId, now } from "./repo-helpers.js";
import * as s from "./schema.js";

export interface LauncherRecentValue {
	id: string;
	launcherId: string;
	fieldId: string;
	value: string;
	createdAt: string;
	updatedAt: string;
}

function rowToLauncherRecentValue(
	row: typeof s.launcherRecentValues.$inferSelect,
): LauncherRecentValue {
	return {
		id: row.id,
		launcherId: row.launcherId,
		fieldId: row.fieldId,
		value: row.value,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

export function createLauncherRecentValueRepo(db: LeitwerkDb) {
	return {
		listByLauncher(launcherId: string): LauncherRecentValue[] {
			return db
				.select()
				.from(s.launcherRecentValues)
				.where(eq(s.launcherRecentValues.launcherId, launcherId))
				.orderBy(desc(s.launcherRecentValues.updatedAt), desc(s.launcherRecentValues.createdAt))
				.all()
				.map(rowToLauncherRecentValue);
		},

		listByField(launcherId: string, fieldId: string, limit = 5): LauncherRecentValue[] {
			return db
				.select()
				.from(s.launcherRecentValues)
				.where(
					and(
						eq(s.launcherRecentValues.launcherId, launcherId),
						eq(s.launcherRecentValues.fieldId, fieldId),
					),
				)
				.orderBy(desc(s.launcherRecentValues.updatedAt), desc(s.launcherRecentValues.createdAt))
				.limit(limit)
				.all()
				.map(rowToLauncherRecentValue);
		},

		recordValue(input: {
			launcherId: string;
			fieldId: string;
			value: string;
			limit?: number;
		}): LauncherRecentValue {
			const existing = db
				.select()
				.from(s.launcherRecentValues)
				.where(
					and(
						eq(s.launcherRecentValues.launcherId, input.launcherId),
						eq(s.launcherRecentValues.fieldId, input.fieldId),
						eq(s.launcherRecentValues.value, input.value),
					),
				)
				.get();
			const ts = now();
			if (existing) {
				db.update(s.launcherRecentValues)
					.set({ updatedAt: ts })
					.where(eq(s.launcherRecentValues.id, existing.id))
					.run();
				this.pruneField(input.launcherId, input.fieldId, input.limit ?? 5);
				return { ...rowToLauncherRecentValue(existing), updatedAt: ts };
			}
			const values = {
				id: generateId("lrv"),
				launcherId: input.launcherId,
				fieldId: input.fieldId,
				value: input.value,
				createdAt: ts,
				updatedAt: ts,
			};
			db.insert(s.launcherRecentValues).values(values).run();
			this.pruneField(input.launcherId, input.fieldId, input.limit ?? 5);
			return rowToLauncherRecentValue(values);
		},

		pruneField(launcherId: string, fieldId: string, limit = 5): void {
			const stale = db
				.select({ id: s.launcherRecentValues.id })
				.from(s.launcherRecentValues)
				.where(
					and(
						eq(s.launcherRecentValues.launcherId, launcherId),
						eq(s.launcherRecentValues.fieldId, fieldId),
					),
				)
				.orderBy(desc(s.launcherRecentValues.updatedAt), desc(s.launcherRecentValues.createdAt))
				.all()
				.slice(limit);
			for (const entry of stale) {
				db.delete(s.launcherRecentValues).where(eq(s.launcherRecentValues.id, entry.id)).run();
			}
		},
	};
}
