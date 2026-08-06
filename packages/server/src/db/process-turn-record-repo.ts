import type {
	ModelSelectionProvenance,
	ProcessTurnRecord,
	ProcessTurnRecordPathType,
	ProcessTurnRecordStatus,
	ProcessTurnType,
	TurnId,
	WorkerErrorClass,
} from "@leitwerk-dev/domain";
import { asc, desc, eq } from "drizzle-orm";
import type { LeitwerkDb } from "./database.js";
import { generateId, now } from "./repo-helpers.js";
import * as s from "./schema.js";

export interface CreateProcessTurnRecordInput {
	id?: string;
	instanceId: string;
	turnId: TurnId;
	turnType?: ProcessTurnType;
	status?: ProcessTurnRecordStatus;
	attemptNumber?: number;
	parentTurnRecordId?: string | null;
	turnStartRecordId?: string | null;
	acceptedWorkerLeaseId?: string | null;
	pathType?: ProcessTurnRecordPathType;
	forkPiEntryId?: string | null;
	resultPiEntryId?: string | null;
	modelProfileId?: string | null;
	modelSelectionProvenance?: ModelSelectionProvenance | null;
	turnResultMarkdown?: string | null;
	errorSummary?: string | null;
	errorClass?: WorkerErrorClass | null;
	startedAt?: string;
	endedAt?: string | null;
}

export interface UpdateProcessTurnRecordInput {
	turnType?: ProcessTurnType;
	status?: ProcessTurnRecordStatus;
	attemptNumber?: number;
	parentTurnRecordId?: string | null;
	turnStartRecordId?: string | null;
	acceptedWorkerLeaseId?: string | null;
	forkPiEntryId?: string | null;
	resultPiEntryId?: string | null;
	modelProfileId?: string | null;
	modelSelectionProvenance?: ModelSelectionProvenance | null;
	turnResultMarkdown?: string | null;
	errorSummary?: string | null;
	errorClass?: WorkerErrorClass | null;
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
		turnResultMarkdown: row.turnResultMarkdown ?? null,
		errorSummary: row.errorSummary ?? null,
		errorClass: (row.errorClass as WorkerErrorClass | null | undefined) ?? null,
		startedAt: row.startedAt,
		endedAt: row.endedAt ?? null,
	};
}

export function createProcessTurnRecordRepo(db: LeitwerkDb) {
	return {
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
			};
			db.insert(s.turnRecords).values(values).run();
			return rowToProcessTurnRecord(values);
		},

		getById(id: string): ProcessTurnRecord | null {
			const row = db.select().from(s.turnRecords).where(eq(s.turnRecords.id, id)).get();
			return row ? rowToProcessTurnRecord(row) : null;
		},

		listByInstance(instanceId: string): ProcessTurnRecord[] {
			return db
				.select()
				.from(s.turnRecords)
				.where(eq(s.turnRecords.instanceId, instanceId))
				.orderBy(asc(s.turnRecords.startedAt))
				.all()
				.map(rowToProcessTurnRecord);
		},

		getLatestSucceededPrimaryByInstance(instanceId: string): ProcessTurnRecord | null {
			const row = db
				.select()
				.from(s.turnRecords)
				.where(eq(s.turnRecords.instanceId, instanceId))
				.orderBy(desc(s.turnRecords.startedAt))
				.all()
				.map(rowToProcessTurnRecord)
				.find(
					(run) =>
						run.status === "succeeded" &&
						run.pathType === "primary" &&
						typeof run.resultPiEntryId === "string" &&
						run.resultPiEntryId.length > 0,
				);
			return row ?? null;
		},

		update(id: string, input: UpdateProcessTurnRecordInput): ProcessTurnRecord | null {
			const setValues: Record<string, unknown> = {};
			if (input.turnType !== undefined) setValues.turnType = input.turnType;
			if (input.status !== undefined) setValues.status = input.status;
			if (input.attemptNumber !== undefined) setValues.attemptNumber = input.attemptNumber;
			if (input.parentTurnRecordId !== undefined)
				setValues.parentTurnRecordId = input.parentTurnRecordId;
			if (input.turnStartRecordId !== undefined)
				setValues.turnStartRecordId = input.turnStartRecordId;
			if (input.acceptedWorkerLeaseId !== undefined)
				setValues.acceptedWorkerLeaseId = input.acceptedWorkerLeaseId;
			if (input.forkPiEntryId !== undefined) setValues.forkPiEntryId = input.forkPiEntryId;
			if (input.resultPiEntryId !== undefined) setValues.resultPiEntryId = input.resultPiEntryId;
			if (input.modelProfileId !== undefined) setValues.modelProfileId = input.modelProfileId;
			if (input.modelSelectionProvenance !== undefined) {
				setValues.modelSelectionKind = input.modelSelectionProvenance?.kind ?? null;
				setValues.modelSelectionSource = input.modelSelectionProvenance?.source ?? null;
			}
			if (input.turnResultMarkdown !== undefined)
				setValues.turnResultMarkdown = input.turnResultMarkdown;
			if (input.errorSummary !== undefined) setValues.errorSummary = input.errorSummary;
			if (input.errorClass !== undefined) setValues.errorClass = input.errorClass;
			if (input.endedAt !== undefined) setValues.endedAt = input.endedAt;

			db.update(s.turnRecords).set(setValues).where(eq(s.turnRecords.id, id)).run();
			return this.getById(id);
		},
	};
}
