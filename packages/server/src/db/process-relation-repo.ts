import type { Actor, ProcessRelation } from "@leitwerk-dev/domain";
import { asc, eq } from "drizzle-orm";
import type { LeitwerkDb } from "./database.js";
import { now, parsePersistedJson } from "./repo-helpers.js";
import * as s from "./schema.js";

function map(row: typeof s.processRelations.$inferSelect): ProcessRelation {
	return {
		parentInstanceId: row.parentInstanceId,
		childInstanceId: row.childInstanceId,
		kind: "derived",
		purpose: row.purpose,
		createdAt: row.createdAt,
		createdBy: parsePersistedJson<Actor>(row.createdByJson, "process relation actor"),
	};
}

export function createProcessRelationRepo(db: LeitwerkDb) {
	return {
		create(
			input: Omit<ProcessRelation, "kind" | "createdAt"> & { createdAt?: string },
		): ProcessRelation {
			const row = db
				.insert(s.processRelations)
				.values({
					parentInstanceId: input.parentInstanceId,
					childInstanceId: input.childInstanceId,
					kind: "derived",
					purpose: input.purpose,
					createdAt: input.createdAt ?? now(),
					createdByJson: JSON.stringify(input.createdBy),
				})
				.returning()
				.get();
			return map(row);
		},
		getByChild(childInstanceId: string): ProcessRelation | null {
			const row = db
				.select()
				.from(s.processRelations)
				.where(eq(s.processRelations.childInstanceId, childInstanceId))
				.get();
			return row ? map(row) : null;
		},
		listByParent(parentInstanceId: string): ProcessRelation[] {
			return db
				.select()
				.from(s.processRelations)
				.where(eq(s.processRelations.parentInstanceId, parentInstanceId))
				.orderBy(asc(s.processRelations.createdAt))
				.all()
				.map(map);
		},
	};
}
