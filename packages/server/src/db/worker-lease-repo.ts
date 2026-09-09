import type { WorkerBootstrapReceipt, WorkerLease, WorkerState } from "@leitwerk-dev/domain";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { SQLiteUpdateSetSource } from "drizzle-orm/sqlite-core";
import type { LeitwerkDb } from "./database.js";
import { generateId, now } from "./repo-helpers.js";
import * as s from "./schema.js";

export interface CreateWorkerLeaseInput {
	instanceId: string;
	workerId: string;
	state: WorkerState;
	serverEpoch?: string | null;
	connectTokenHash?: string | null;
	snapshotTokenHash?: string | null;
	modelPolicyFingerprint?: string | null;
	bootstrapReceipt?: WorkerBootstrapReceipt | null;
	turnStartRecordId?: string | null;
}

export interface UpdateWorkerLeaseInput {
	state?: WorkerState;
	serverEpoch?: string | null;
	connectTokenHash?: string | null;
	snapshotTokenHash?: string | null;
	modelPolicyFingerprint?: string | null;
	lastHeartbeatAt?: string | null;
	connectedAt?: string | null;
	workspacePreparationStartedAt?: string | null;
	readyAt?: string | null;
	exitedAt?: string | null;
}

function rowToWorkerLease(row: typeof s.workerLeases.$inferSelect): WorkerLease {
	return {
		id: row.id,
		instanceId: row.instanceId,
		workerId: row.workerId,
		turnStartRecordId: row.turnStartRecordId ?? null,
		state: row.state as WorkerState,
		serverEpoch: row.serverEpoch ?? null,
		connectTokenHash: row.connectTokenHash ?? null,
		snapshotTokenHash: row.snapshotTokenHash ?? null,
		modelPolicyFingerprint: row.modelPolicyFingerprint ?? null,
		bootstrapReceipt: row.bootstrapReceiptJson
			? (JSON.parse(row.bootstrapReceiptJson) as WorkerBootstrapReceipt)
			: null,
		lastHeartbeatAt: row.lastHeartbeatAt,
		startedAt: row.startedAt,
		connectedAt: row.connectedAt ?? null,
		workspacePreparationStartedAt: row.workspacePreparationStartedAt ?? null,
		readyAt: row.readyAt ?? null,
		exitedAt: row.exitedAt,
	};
}

export function createWorkerLeaseRepo(db: LeitwerkDb) {
	return {
		create(input: CreateWorkerLeaseInput): WorkerLease {
			const id = generateId("wls");
			const ts = now();
			const values = {
				id,
				instanceId: input.instanceId,
				workerId: input.workerId,
				state: input.state,
				serverEpoch: input.serverEpoch ?? null,
				connectTokenHash: input.connectTokenHash ?? null,
				snapshotTokenHash: input.snapshotTokenHash ?? null,
				modelPolicyFingerprint: input.modelPolicyFingerprint ?? null,
				bootstrapReceiptJson: null,
				turnStartRecordId: input.turnStartRecordId ?? null,
				lastHeartbeatAt: null as string | null,
				startedAt: ts,
				connectedAt: null as string | null,
				workspacePreparationStartedAt: null as string | null,
				readyAt: null as string | null,
				exitedAt: null as string | null,
			};
			db.insert(s.workerLeases).values(values).run();
			return rowToWorkerLease(values);
		},

		getByInstance(instanceId: string): WorkerLease | null {
			const row = db
				.select()
				.from(s.workerLeases)
				.where(and(eq(s.workerLeases.instanceId, instanceId), isNull(s.workerLeases.exitedAt)))
				.get();
			return row ? rowToWorkerLease(row) : null;
		},

		getById(id: string): WorkerLease | null {
			const row = db.select().from(s.workerLeases).where(eq(s.workerLeases.id, id)).get();
			return row ? rowToWorkerLease(row) : null;
		},

		listByInstance(instanceId: string): WorkerLease[] {
			return db
				.select()
				.from(s.workerLeases)
				.where(eq(s.workerLeases.instanceId, instanceId))
				.orderBy(asc(s.workerLeases.startedAt), asc(s.workerLeases.id))
				.all()
				.map(rowToWorkerLease);
		},

		listActive(): WorkerLease[] {
			return db
				.select()
				.from(s.workerLeases)
				.where(isNull(s.workerLeases.exitedAt))
				.all()
				.map(rowToWorkerLease);
		},

		update(id: string, input: UpdateWorkerLeaseInput): WorkerLease | null {
			const setValues: SQLiteUpdateSetSource<typeof s.workerLeases> = {
				state: input.state,
				serverEpoch: input.serverEpoch,
				connectTokenHash: input.connectTokenHash,
				snapshotTokenHash: input.snapshotTokenHash,
				modelPolicyFingerprint: input.modelPolicyFingerprint,
				lastHeartbeatAt: input.lastHeartbeatAt,
				connectedAt: input.connectedAt,
				workspacePreparationStartedAt: input.workspacePreparationStartedAt,
				readyAt: input.readyAt,
				exitedAt: input.exitedAt,
			};

			db.update(s.workerLeases).set(setValues).where(eq(s.workerLeases.id, id)).run();
			const row = db.select().from(s.workerLeases).where(eq(s.workerLeases.id, id)).get();
			return row ? rowToWorkerLease(row) : null;
		},

		observeTimestamp(
			id: string,
			field: "connectedAt" | "workspacePreparationStartedAt" | "readyAt",
		): WorkerLease | null {
			const column = s.workerLeases[field];
			db.update(s.workerLeases)
				.set({ [field]: now() })
				.where(and(eq(s.workerLeases.id, id), isNull(column)))
				.run();
			return this.getById(id);
		},

		updateHeartbeat(workerId: string): boolean {
			const result = db
				.update(s.workerLeases)
				.set({ lastHeartbeatAt: now() })
				.where(eq(s.workerLeases.workerId, workerId))
				.run();
			return result.changes > 0;
		},

		/** Stores the first receipt only. Exact replay is accepted; changed receipts are rejected. */
		compareAndSetBootstrapReceipt(
			id: string,
			receipt: WorkerBootstrapReceipt,
		): "stored" | "replay" | "changed" | "missing" {
			const existing = db.select().from(s.workerLeases).where(eq(s.workerLeases.id, id)).get();
			if (!existing) return "missing";
			const encoded = JSON.stringify(receipt);
			if (existing.bootstrapReceiptJson !== null)
				return existing.bootstrapReceiptJson === encoded ? "replay" : "changed";
			const result = db
				.update(s.workerLeases)
				.set({ bootstrapReceiptJson: encoded })
				.where(and(eq(s.workerLeases.id, id), isNull(s.workerLeases.bootstrapReceiptJson)))
				.run();
			return result.changes === 1 ? "stored" : "changed";
		},
	};
}
