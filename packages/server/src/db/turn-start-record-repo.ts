import type {
	ProcessTurnType,
	TurnStartKind,
	TurnStartRecord,
	TurnStartRecordState,
} from "@leitwerk-dev/domain";
import { and, eq } from "drizzle-orm";
import type { LeitwerkDb } from "./database.js";
import { generateId, now, parsePersistedJson } from "./repo-helpers.js";
import * as s from "./schema.js";

function map(row: typeof s.turnStartRecords.$inferSelect): TurnStartRecord {
	return {
		id: row.id,
		instanceId: row.instanceId,
		turnId: row.turnId,
		turnType: row.turnType as Extract<ProcessTurnType, "llm" | "automatic">,
		proposedTurnRecordId: row.proposedTurnRecordId,
		startKind: row.startKind as TurnStartKind,
		recoveryTurnRecordId: row.recoveryTurnRecordId ?? null,
		continuation: row.continuationJson
			? parsePersistedJson(row.continuationJson, "turn start continuation")
			: null,
		state: parsePersistedJson<TurnStartRecordState>(row.stateJson, "turn start state"),
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

export function createTurnStartRecordRepo(db: LeitwerkDb) {
	return {
		create(
			input: Omit<TurnStartRecord, "id" | "createdAt" | "updatedAt"> & { id?: string },
		): TurnStartRecord {
			const ts = now();
			const id = input.id ?? generateId("tsr");
			const value = {
				id,
				instanceId: input.instanceId,
				turnId: input.turnId,
				turnType: input.turnType,
				proposedTurnRecordId: input.proposedTurnRecordId,
				startKind: input.startKind,
				recoveryTurnRecordId: input.recoveryTurnRecordId,
				continuationJson: input.continuation ? JSON.stringify(input.continuation) : null,
				stateJson: JSON.stringify(input.state),
				createdAt: ts,
				updatedAt: ts,
			};
			db.insert(s.turnStartRecords).values(value).run();
			return map(value);
		},
		getById(id: string): TurnStartRecord | null {
			const value = db.select().from(s.turnStartRecords).where(eq(s.turnStartRecords.id, id)).get();
			return value ? map(value) : null;
		},
		listByInstance(instanceId: string): TurnStartRecord[] {
			return db
				.select()
				.from(s.turnStartRecords)
				.where(eq(s.turnStartRecords.instanceId, instanceId))
				.all()
				.map(map);
		},
		compareAndSetState(input: {
			id: string;
			expectedKind: TurnStartRecordState["kind"];
			state: TurnStartRecordState;
		}): TurnStartRecord | null {
			const current = this.getById(input.id);
			if (!current || current.state.kind !== input.expectedKind) return null;
			const result = db
				.update(s.turnStartRecords)
				.set({ stateJson: JSON.stringify(input.state), updatedAt: now() })
				.where(
					and(
						eq(s.turnStartRecords.id, input.id),
						eq(s.turnStartRecords.stateJson, JSON.stringify(current.state)),
					),
				)
				.run();
			return result.changes === 1 ? this.getById(input.id) : null;
		},
	};
}
