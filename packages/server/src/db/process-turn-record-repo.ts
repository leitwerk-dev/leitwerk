import type {
	MappedTurnItemRef,
	ModelSelectionProvenance,
	ProcessTurnRecord,
	ProcessTurnRecordPathType,
	ProcessTurnRecordStatus,
	ProcessTurnType,
	TurnId,
	WorkerErrorClass,
} from "@leitwerk-dev/domain";
import { and, asc, desc, eq, getTableColumns, isNull, ne, sql } from "drizzle-orm";
import type { SQLiteUpdateSetSource } from "drizzle-orm/sqlite-core";
import type { LeitwerkDb } from "./database.js";
import { generateId, mappedItemRef, now } from "./repo-helpers.js";
import * as s from "./schema.js";

/** @internal */
export interface CreateProcessTurnRecordInput extends UpdateProcessTurnRecordInput {
	/** @internal */
	id?: string;
	/** @internal */
	instanceId: string;
	/** @internal */
	turnId: TurnId;
	/** @internal */
	pathType?: ProcessTurnRecordPathType;
	/** @internal */
	startedAt?: string;
}

/** @internal */
export interface UpdateProcessTurnRecordInput {
	/** @internal */
	turnType?: ProcessTurnType;
	/** @internal */
	status?: ProcessTurnRecordStatus;
	/** @internal */
	attemptNumber?: number;
	/** @internal */
	parentTurnRecordId?: string | null;
	/** @internal */
	turnStartRecordId?: string | null;
	/** @internal */
	acceptedWorkerLeaseId?: string | null;
	/** @internal */
	forkPiEntryId?: string | null;
	/** @internal */
	resultPiEntryId?: string | null;
	/** @internal */
	modelProfileId?: string | null;
	/** @internal */
	modelSelectionProvenance?: ModelSelectionProvenance | null;
	/** @internal */
	iteration?: MappedTurnItemRef | null;
	/** @internal */
	turnResultMarkdown?: string | null;
	/** @internal */
	errorSummary?: string | null;
	/** @internal */
	errorClass?: WorkerErrorClass | null;
	/** @internal */
	endedAt?: string | null;
}

function rowToProcessTurnRecord(row: typeof s.turnRecords.$inferSelect): ProcessTurnRecord {
	return {
		id: row.id,
		instanceId: row.instanceId,
		turnId: row.turnId,
		turnType: row.turnType as ProcessTurnType,
		status: row.status as ProcessTurnRecordStatus,
		attemptNumber: row.attemptNumber,
		parentTurnRecordId: row.parentTurnRecordId ?? null,
		turnStartRecordId: row.turnStartRecordId ?? null,
		acceptedWorkerLeaseId: row.acceptedWorkerLeaseId ?? null,
		pathType: row.pathType as ProcessTurnRecordPathType,
		forkPiEntryId: row.forkPiEntryId ?? null,
		resultPiEntryId: row.resultPiEntryId ?? null,
		modelProfileId: row.modelProfileId ?? null,
		modelSelectionProvenance:
			row.modelSelectionKind && row.modelSelectionSource
				? {
						kind: row.modelSelectionKind as ModelSelectionProvenance["kind"],
						source: row.modelSelectionSource as ModelSelectionProvenance["source"],
					}
				: null,
		iteration: mappedItemRef(row),
		turnResultMarkdown: row.turnResultMarkdown ?? null,
		errorSummary: row.errorSummary ?? null,
		errorClass: (row.errorClass as WorkerErrorClass | null | undefined) ?? null,
		startedAt: row.startedAt,
		endedAt: row.endedAt ?? null,
	};
}

/** @public */
export function createProcessTurnRecordRepo(db: LeitwerkDb) {
	return {
		/** @internal */
		create(input: CreateProcessTurnRecordInput): ProcessTurnRecord {
			const id = input.id ?? generateId("trn");
			const values = {
				id,
				instanceId: input.instanceId,
				turnId: input.turnId,
				turnType: input.turnType ?? "llm",
				status: input.status ?? "running",
				attemptNumber: input.attemptNumber ?? 1,
				parentTurnRecordId: input.parentTurnRecordId ?? null,
				turnStartRecordId: input.turnStartRecordId ?? null,
				acceptedWorkerLeaseId: input.acceptedWorkerLeaseId ?? null,
				pathType: input.pathType ?? "primary",
				forkPiEntryId: input.forkPiEntryId ?? null,
				resultPiEntryId: input.resultPiEntryId ?? null,
				modelProfileId: input.modelProfileId ?? null,
				modelSelectionKind: input.modelSelectionProvenance?.kind ?? null,
				modelSelectionSource: input.modelSelectionProvenance?.source ?? null,
				turnResultMarkdown: input.turnResultMarkdown ?? null,
				errorSummary: input.errorSummary ?? null,
				errorClass: input.errorClass ?? null,
				startedAt: input.startedAt ?? now(),
				endedAt: input.endedAt ?? null,
				mappedRunId: input.iteration?.runId ?? null,
				mappedItemKey: input.iteration?.itemKey ?? null,
				mappedItemIndex: input.iteration?.itemIndex ?? null,
			};
			db.insert(s.turnRecords).values(values).run();
			return rowToProcessTurnRecord(values);
		},

		/** @internal */
		getById(id: string): ProcessTurnRecord | null {
			const row = db.select().from(s.turnRecords).where(eq(s.turnRecords.id, id)).get();
			return row ? rowToProcessTurnRecord(row) : null;
		},

		/** @public */
		listByInstance(instanceId: string): ProcessTurnRecord[] {
			return db
				.select()
				.from(s.turnRecords)
				.where(eq(s.turnRecords.instanceId, instanceId))
				.orderBy(asc(s.turnRecords.startedAt))
				.all()
				.map(rowToProcessTurnRecord);
		},

		/** Only absent summaries need repair; don't read every retained turn at startup. @internal */
		listMissingSummaries(instanceId: string): ProcessTurnRecord[] {
			return db
				.select(getTableColumns(s.turnRecords))
				.from(s.turnRecords)
				.leftJoin(s.turnSummaries, eq(s.turnSummaries.turnRecordId, s.turnRecords.id))
				.where(and(eq(s.turnRecords.instanceId, instanceId), isNull(s.turnSummaries.turnRecordId)))
				.all()
				.map(rowToProcessTurnRecord);
		},
		/** A stable page, even when new turns arrive or timestamps tie. @internal */
		listPage(
			instanceId: string,
			before?: Pick<ProcessTurnRecord, "startedAt" | "id">,
			limit = 40,
		): ProcessTurnRecord[] {
			return db
				.select()
				.from(s.turnRecords)
				.where(
					and(
						eq(s.turnRecords.instanceId, instanceId),
						before
							? sql`(${s.turnRecords.startedAt}, ${s.turnRecords.id}) < (${before.startedAt}, ${before.id})`
							: undefined,
					),
				)
				.orderBy(desc(s.turnRecords.startedAt), desc(s.turnRecords.id))
				.limit(limit)
				.all()
				.map(rowToProcessTurnRecord)
				.reverse();
		},

		/** @internal */
		getLatestSucceededPrimaryByInstance(instanceId: string): ProcessTurnRecord | null {
			const row = db
				.select()
				.from(s.turnRecords)
				.where(
					and(
						eq(s.turnRecords.instanceId, instanceId),
						eq(s.turnRecords.status, "succeeded"),
						eq(s.turnRecords.pathType, "primary"),
						ne(s.turnRecords.resultPiEntryId, ""),
					),
				)
				.orderBy(desc(s.turnRecords.startedAt))
				.get();
			return row ? rowToProcessTurnRecord(row) : null;
		},

		/** @internal */
		update(id: string, input: UpdateProcessTurnRecordInput): ProcessTurnRecord | null {
			const setValues: SQLiteUpdateSetSource<typeof s.turnRecords> = {
				turnType: input.turnType,
				status: input.status,
				attemptNumber: input.attemptNumber,
				parentTurnRecordId: input.parentTurnRecordId,
				turnStartRecordId: input.turnStartRecordId,
				acceptedWorkerLeaseId: input.acceptedWorkerLeaseId,
				forkPiEntryId: input.forkPiEntryId,
				resultPiEntryId: input.resultPiEntryId,
				modelProfileId: input.modelProfileId,
				turnResultMarkdown: input.turnResultMarkdown,
				errorSummary: input.errorSummary,
				errorClass: input.errorClass,
				endedAt: input.endedAt,
			};
			if (input.modelSelectionProvenance !== undefined) {
				setValues.modelSelectionKind = input.modelSelectionProvenance?.kind ?? null;
				setValues.modelSelectionSource = input.modelSelectionProvenance?.source ?? null;
			}

			db.update(s.turnRecords).set(setValues).where(eq(s.turnRecords.id, id)).run();
			return this.getById(id);
		},
	};
}
