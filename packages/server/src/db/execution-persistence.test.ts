import type { WorkerBootstrapReceipt } from "@leitwerk-dev/domain";
import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { createAes256GcmCredentialCipher } from "./credential-cipher.js";
import { createInMemoryDatabase, type LeitwerkDb } from "./database.js";
import { createProcessInstanceRepo } from "./process-instance-repo.js";
import { createProviderCredentialRepo } from "./provider-credential-repo.js";
import { createTurnStartRecordRepo } from "./turn-start-record-repo.js";
import { createWorkerLeaseRepo } from "./worker-lease-repo.js";

let db: LeitwerkDb;

beforeEach(() => {
	db = createInMemoryDatabase();
});

function client(): Database.Database {
	return (db as unknown as { $client: Database.Database }).$client;
}

describe("turn-start persistence", () => {
	it("round-trips immutable preparation and swaps the current worker anchor", () => {
		const processes = createProcessInstanceRepo(db);
		const starts = createTurnStartRecordRepo(db);
		const process = processes.create({ processId: "test_process", lifecycleStatus: "active" });
		const start = starts.create({
			instanceId: process.id,
			turnId: "generate",
			turnType: "llm",
			proposedTurnRecordId: "trn_reserved",
			startKind: "continue",
			recoveryTurnRecordId: null,
			continuation: {
				continueFromPiEntryId: "entry-approved",
				continuePrompt: "Continue exactly",
				savedPrimaryLeafEntryId: "leaf-primary",
			},
			state: {
				kind: "starting",
				start: {
					kind: "llm",
					model: {
						profileId: "profile",
						providerId: "provider",
						modelId: "model",
						thinkingLevel: "medium",
					},
					providerOptions: { account: "preferred" },
					providerWorkerConfig: { version: 1, value: { endpoint: "https://broker" } },
					piResourceSnapshotDigest: "a".repeat(64),
					workerRuntimeProfileId: "generic",
					piSettings: { packages: [] },
				},
			},
		});

		expect(starts.getById(start.id)).toEqual(start);
		expect(
			processes.update(process.id, {
				currentExecution: { kind: "worker_start", id: start.id },
			})?.currentExecution,
		).toEqual({ kind: "worker_start", id: start.id });
		expect(processes.delete(process.id)).toBe(true);
		expect(starts.getById(start.id)).toBeNull();
	});

	it("compare-and-sets state from the expected persisted kind", () => {
		const processes = createProcessInstanceRepo(db);
		const starts = createTurnStartRecordRepo(db);
		const process = processes.create({ processId: "test_process" });
		const start = starts.create({
			instanceId: process.id,
			turnId: "automatic",
			turnType: "automatic",
			proposedTurnRecordId: "trn_automatic",
			startKind: "selected_turn",
			recoveryTurnRecordId: null,
			continuation: null,
			state: { kind: "starting", start: { kind: "automatic" } },
		});
		const accepted = starts.compareAndSetState({
			id: start.id,
			expectedKind: "starting",
			state: {
				kind: "accepted",
				start: { kind: "automatic" },
				turnRecordId: "trn_automatic",
				acceptedWorkerLeaseId: "lease",
			},
		});
		expect(accepted?.state.kind).toBe("accepted");
		expect(
			starts.compareAndSetState({
				id: start.id,
				expectedKind: "starting",
				state: { kind: "superseded", start: { kind: "automatic" } },
			}),
		).toBeNull();
	});
});

describe("worker bootstrap receipt persistence", () => {
	it("stores once, accepts an exact replay, and rejects a changed replay", () => {
		const processes = createProcessInstanceRepo(db);
		const leases = createWorkerLeaseRepo(db);
		const process = processes.create({ processId: "test_process" });
		const lease = leases.create({
			instanceId: process.id,
			workerId: "worker",
			state: "bootstrapping",
		});
		const receipt: WorkerBootstrapReceipt = {
			kind: "automatic",
			startRecordId: "start",
			workerLeaseId: lease.id,
			receiptEpoch: "epoch",
			readyAt: "2026-07-22T00:00:00.000Z",
		};
		expect(leases.compareAndSetBootstrapReceipt(lease.id, receipt)).toBe("stored");
		expect(leases.compareAndSetBootstrapReceipt(lease.id, receipt)).toBe("replay");
		expect(
			leases.compareAndSetBootstrapReceipt(lease.id, { ...receipt, receiptEpoch: "changed" }),
		).toBe("changed");
		expect(leases.getByInstance(process.id)?.bootstrapReceipt).toEqual(receipt);
	});
});

describe("provider credential persistence", () => {
	it("stores ciphertext and advances revisions only through compare-and-set", () => {
		const cipher = createAes256GcmCredentialCipher(Buffer.alloc(32, 7));
		const credentials = createProviderCredentialRepo(db, cipher);
		const created = credentials.create({
			providerId: "provider",
			payload: '{"token":"top-secret"}',
		});
		expect(created.revision).toBe(1);
		const raw = client()
			.prepare("SELECT encrypted_payload AS payload FROM provider_credentials")
			.get() as { payload: string };
		expect(raw.payload).not.toContain("top-secret");

		expect(
			credentials.compareAndSet({
				providerId: "provider",
				expectedRevision: 0,
				payload: "stale",
			}),
		).toBeNull();
		const updated = credentials.compareAndSet({
			providerId: "provider",
			expectedRevision: 1,
			payload: '{"token":"refreshed"}',
		});
		expect(updated).toMatchObject({ revision: 2 });
		expect(credentials.get("provider")?.payload).toContain("refreshed");
	});

	it("fails closed when the deployment key is unavailable or wrong", () => {
		const correct = createProviderCredentialRepo(
			db,
			createAes256GcmCredentialCipher(Buffer.alloc(32, 1)),
		);
		correct.create({ providerId: "provider", payload: "secret" });
		const wrong = createProviderCredentialRepo(
			db,
			createAes256GcmCredentialCipher(Buffer.alloc(32, 2)),
		);
		expect(() => wrong.get("provider")).toThrow();
		expect(() => createAes256GcmCredentialCipher(Buffer.alloc(31))).toThrow(
			"Credential encryption key must be 32 bytes",
		);
	});
});
