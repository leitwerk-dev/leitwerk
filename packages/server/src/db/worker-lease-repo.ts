import type { WorkerBootstrapReceipt, WorkerLease, WorkerState } from "@leitwerk-dev/domain";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { SQLiteUpdateSetSource } from "drizzle-orm/sqlite-core";
import type { LeitwerkDb } from "./database.js";
import { generateId, now } from "./repo-helpers.js";
import * as s from "./schema.js";

/** @internal */
export interface CreateWorkerLeaseInput {
	/** @internal */
	instanceId: string;
	/** @internal */
	workerId: string;
	/** @internal */
	state: WorkerState;
	/** @internal */
	serverEpoch?: string | null;
	/** @internal */
	connectTokenHash?: string | null;
	/** @internal */
	snapshotTokenHash?: string | null;
	/** @internal */
	modelPolicyFingerprint?: string | null;
	/** @internal */
	bootstrapReceipt?: WorkerBootstrapReceipt | null;
	/** @internal */
	turnStartRecordId?: string | null;
}

/** @internal */
export interface UpdateWorkerLeaseInput {
	/** @internal */
	state?: WorkerState;
	/** @internal */
	serverEpoch?: string | null;
	/** @internal */
	connectTokenHash?: string | null;
	/** @internal */
	snapshotTokenHash?: string | null;
	/** @internal */
	modelPolicyFingerprint?: string | null;
	/** @internal */
	lastHeartbeatAt?: string | null;
	/** @internal */
	connectedAt?: string | null;
	/** @internal */
	workspacePreparationStartedAt?: string | null;
	/** @internal */
	readyAt?: string | null;
	/** @internal */
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

/** @internal */
export function createWorkerLeaseRepo(db: LeitwerkDb) {
	return {
		/** @internal */
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

		/** @internal */
		getByInstance(instanceId: string): WorkerLease | null {
			const row = db
				.select()
				.from(s.workerLeases)
				.where(and(eq(s.workerLeases.instanceId, instanceId), isNull(s.workerLeases.exitedAt)))
				.get();
			return row ? rowToWorkerLease(row) : null;
		},

		/** @internal */
		getById(id: string): WorkerLease | null {
			const row = db.select().from(s.workerLeases).where(eq(s.workerLeases.id, id)).get();
			return row ? rowToWorkerLease(row) : null;
		},

		/** @internal */
		listByInstance(instanceId: string): WorkerLease[] {
			return db
				.select()
				.from(s.workerLeases)
				.where(eq(s.workerLeases.instanceId, instanceId))
				.orderBy(asc(s.workerLeases.startedAt), asc(s.workerLeases.id))
				.all()
				.map(rowToWorkerLease);
		},

		/** @internal */
		listActive(): WorkerLease[] {
			return db
				.select()
				.from(s.workerLeases)
				.where(isNull(s.workerLeases.exitedAt))
				.all()
				.map(rowToWorkerLease);
		},

		/** @internal */
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

		/** @internal */
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

		/** @internal */
		updateHeartbeat(workerId: string): boolean {
			const result = db
				.update(s.workerLeases)
				.set({ lastHeartbeatAt: now() })
				.where(eq(s.workerLeases.workerId, workerId))
				.run();
			return result.changes > 0;
		},

		/** Stores the first receipt only. Exact replay is accepted; changed receipts are rejected. */
		/** @internal */
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
