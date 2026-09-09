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

export function createLauncherRecentValueRepo(db: LeitwerkDb) {
	return {
		listByLauncher(launcherId: string): LauncherRecentValue[] {
			return db
				.select()
				.from(s.launcherRecentValues)
				.where(eq(s.launcherRecentValues.launcherId, launcherId))
				.orderBy(desc(s.launcherRecentValues.updatedAt), desc(s.launcherRecentValues.createdAt))
				.all();
		},

		recordValue(input: {
			launcherId: string;
			fieldId: string;
			value: string;
			limit?: number;
		}): LauncherRecentValue {
			const ts = now();
			const row = db
				.insert(s.launcherRecentValues)
				.values({
					id: generateId("lrv"),
					launcherId: input.launcherId,
					fieldId: input.fieldId,
					value: input.value,
					createdAt: ts,
					updatedAt: ts,
				})
				.onConflictDoUpdate({
					target: [
						s.launcherRecentValues.launcherId,
						s.launcherRecentValues.fieldId,
						s.launcherRecentValues.value,
					],
					set: { updatedAt: ts },
				})
				.returning()
				.get();
			this.pruneField(input.launcherId, input.fieldId, input.limit ?? 5);
			return row;
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
