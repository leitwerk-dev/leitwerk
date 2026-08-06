import type { ExternalWriteLog, ExternalWriteType } from "@leitwerk-dev/domain";
import { desc, eq } from "drizzle-orm";
import type { LeitwerkDb } from "./database.js";
import { generateId, now } from "./repo-helpers.js";
import * as s from "./schema.js";

export interface CreateExternalWriteLogInput {
	instanceId: string;
	writeType: ExternalWriteType;
	dedupKey: string;
	metadata?: Record<string, unknown>;
}

function rowToExternalWriteLog(row: typeof s.externalWriteLog.$inferSelect): ExternalWriteLog {
	return {
		id: row.id,
		instanceId: row.instanceId,
		writeType: row.writeType as ExternalWriteType,
		dedupKey: row.dedupKey,
		completedAt: row.completedAt,
		metadata: JSON.parse(row.metadata) as Record<string, unknown>,
	};
}

export function createExternalWriteLogRepo(db: LeitwerkDb) {
	return {
		record(input: CreateExternalWriteLogInput): ExternalWriteLog {
			const id = generateId("ewl");
			const ts = now();
			const values = {
				id,
				instanceId: input.instanceId,
				writeType: input.writeType,
				dedupKey: input.dedupKey,
				completedAt: ts,
				metadata: JSON.stringify(input.metadata ?? {}),
			};
			db.insert(s.externalWriteLog).values(values).run();
			return rowToExternalWriteLog(values);
		},

		hasDedupKey(dedupKey: string): boolean {
			const row = db
				.select()
				.from(s.externalWriteLog)
				.where(eq(s.externalWriteLog.dedupKey, dedupKey))
				.get();
			return row !== undefined;
		},

		listByInstance(instanceId: string): ExternalWriteLog[] {
			return db
				.select()
				.from(s.externalWriteLog)
				.where(eq(s.externalWriteLog.instanceId, instanceId))
				.orderBy(desc(s.externalWriteLog.completedAt))
				.all()
				.map(rowToExternalWriteLog);
		},
	};
}
