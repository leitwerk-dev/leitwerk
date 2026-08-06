import { eq } from "drizzle-orm";
import type { LeitwerkDb } from "./database.js";
import { now } from "./repo-helpers.js";
import * as s from "./schema.js";

export interface ProcessHandoffDedupKeyRecord {
	key: string;
	instanceId: string;
	createdAt: string;
	metadata: Record<string, unknown>;
}

export interface CreateProcessHandoffDedupKeyInput {
	key: string;
	instanceId: string;
	metadata?: Record<string, unknown> | null;
}

function rowToRecord(
	row: typeof s.processHandoffDedupKeys.$inferSelect,
): ProcessHandoffDedupKeyRecord {
	return {
		key: row.key,
		instanceId: row.instanceId,
		createdAt: row.createdAt,
		metadata: JSON.parse(row.metadata) as Record<string, unknown>,
	};
}

export function createProcessHandoffDedupKeyRepo(db: LeitwerkDb) {
	return {
		create(input: CreateProcessHandoffDedupKeyInput): ProcessHandoffDedupKeyRecord {
			const values = {
				key: input.key,
				instanceId: input.instanceId,
				createdAt: now(),
				metadata: JSON.stringify(input.metadata ?? {}),
			};
			db.insert(s.processHandoffDedupKeys).values(values).run();
			return rowToRecord(values);
		},

		getByKey(key: string): ProcessHandoffDedupKeyRecord | null {
			const row = db
				.select()
				.from(s.processHandoffDedupKeys)
				.where(eq(s.processHandoffDedupKeys.key, key))
				.get();
			return row ? rowToRecord(row) : null;
		},
	};
}
