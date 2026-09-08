import { Readable } from "node:stream";
import { DEFAULT_SESSION_TRANSFER_LIMITS } from "@leitwerk-dev/session-transfer";
import type { ProcessStateExportHelperRelay } from "@leitwerk-dev/worker-runners";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LeitwerkConfig } from "./config/config-types.js";
import { closeDatabase, createInMemoryDatabase, type LeitwerkDb } from "./db/database.js";
import { createAllRepos } from "./db/repositories.js";
import { createProcessOperationCoordinator } from "./process-operation-coordinator.js";
import { createSessionTransferHelperRelays } from "./session-transfer-helper-relays.js";
import {
	createSessionTransferService,
	type SessionTransferService,
} from "./session-transfer-service.js";

const databases: LeitwerkDb[] = [];
const services: SessionTransferService[] = [];

afterEach(() => {
	for (const service of services.splice(0)) service.stop();
	for (const database of databases.splice(0)) closeDatabase(database);
});

function harness(
	lifecycleStatus: "active" | "waiting" = "waiting",
	deletionPending = false,
	helperExport = false,
) {
	const db = createInMemoryDatabase();
	databases.push(db);
	const repos = createAllRepos(db);
	const process = repos.processes.create({ processId: "demo", lifecycleStatus, title: "Demo" });
	const streamBody = Buffer.from("portable archive bytes");
	const helperRelays = createSessionTransferHelperRelays({
		repos,
		limits: DEFAULT_SESSION_TRANSFER_LIMITS,
	});
	const createdHelperRelays: ProcessStateExportHelperRelay[] = [];
	const prepare = vi.fn(async (request) => {
		if (helperExport) {
			const relay = helperRelays.create({
				instanceId: request.instanceId,
				manifest: request.manifest,
			});
			createdHelperRelays.push(relay);
			const report = await relay.waitForPreflight(request.signal);
			return { ...report, stream: () => relay.activateStream() };
		}
		return {
			manifest: request.manifest,
			preflight: { entriesTotal: 2, logicalBytesTotal: 42 },
			stream: () => Readable.from([streamBody]),
		};
	});
	const stopWorker = vi.fn(async () => undefined);
	const processOperations = createProcessOperationCoordinator();
	const service = createSessionTransferService({
		repos,
		processOperations,
		supervisor: { stopWorker } as never,
		exporter: { prepare, reconcile: async () => undefined },
		helperRelays,
		sessionSource: {
			async readSnapshotHandle() {
				return {
					signature: "snapshot-1",
					load: async () =>
						`${JSON.stringify({ type: "session", version: 3, id: "session-1", cwd: "/source/workspace" })}\n`,
				};
			},
		},
		isDeletionPending: () => deletionPending,
		config: {
			workers: { runner: "local" },
			storage: { process_workspaces_dir: "/tmp/processes", tree_files_dir: "/tmp/trees" },
		} as LeitwerkConfig,
	});
	services.push(service);
	return {
		repos,
		process,
		service,
		prepare,
		stopWorker,
		streamBody,
		processOperations,
		createdHelperRelays,
	};
}

async function grant(service: SessionTransferService, instanceId: string) {
	const result = await service.createGrant(instanceId);
	if (result.kind !== "created") throw new Error(`Expected grant, got ${result.kind}`);
	return result;
}

describe("session transfer service", () => {
	it("rejects grant creation once process deletion has priority", async () => {
		const { process, service } = harness("waiting", true);
		await expect(service.createGrant(process.id)).resolves.toEqual({ kind: "deletion_pending" });
	});

	it("waits for the accepted execution chain to become quiescent before stopping a worker", async () => {
		const { repos, process, service, prepare, stopWorker, processOperations } = harness("active");
		const createdGrant = await grant(service, process.id);
		const started = service.startAttempt({
			instanceId: process.id,
			grantId: createdGrant.grantId,
			token: createdGrant.rawToken,
		});
		expect(started.kind).toBe("created");
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(prepare).not.toHaveBeenCalled();
		expect(stopWorker).not.toHaveBeenCalled();
		if (started.kind !== "created") return;
		expect(service.activeForProcess(process.id)?.phase).toBe("waiting_for_execution_chain");

		repos.processes.update(process.id, { lifecycleStatus: "waiting" });
		await vi.waitFor(() =>
			expect(service.activeForProcess(process.id)?.phase).toBe("ready_to_stream"),
		);
		expect(stopWorker).toHaveBeenCalledWith(process.id, "session_transfer");
		expect(prepare).toHaveBeenCalledOnce();
		await expect(processOperations.runExclusive(process.id, () => "not blocked")).resolves.toBe(
			"not blocked",
		);
		service.cancelForWeb(process.id, started.attempt.id);
	});

	it("admits one active attempt per process while preserving the other grant", async () => {
		const { process, service } = harness();
		const firstGrant = await grant(service, process.id);
		const secondGrant = await grant(service, process.id);
		const first = service.startAttempt({
			instanceId: process.id,
			grantId: firstGrant.grantId,
			token: firstGrant.rawToken,
		});
		const busy = service.startAttempt({
			instanceId: process.id,
			grantId: secondGrant.grantId,
			token: secondGrant.rawToken,
		});
		expect(first.kind).toBe("created");
		expect(busy).toEqual({ kind: "busy" });
		if (first.kind !== "created") return;
		service.cancelForWeb(process.id, first.attempt.id);
		const retried = service.startAttempt({
			instanceId: process.id,
			grantId: secondGrant.grantId,
			token: secondGrant.rawToken,
		});
		expect(retried.kind).toBe("created");
		if (retried.kind === "created") service.cancelForWeb(process.id, retried.attempt.id);
	});

	it("does not revive a cancelled attempt when exporter preparation finishes", async () => {
		const { repos, process, service, prepare, streamBody } = harness();
		const preparation = Promise.withResolvers<Awaited<ReturnType<typeof prepare>>>();
		prepare.mockImplementationOnce(() => preparation.promise);
		const createdGrant = await grant(service, process.id);
		const started = service.startAttempt({
			instanceId: process.id,
			grantId: createdGrant.grantId,
			token: createdGrant.rawToken,
		});
		if (started.kind !== "created") throw new Error("Expected attempt");
		await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
		expect(service.cancelForWeb(process.id, started.attempt.id)?.phase).toBe("cancelled");

		preparation.resolve({
			manifest: prepare.mock.calls[0]?.[0].manifest,
			preflight: { entriesTotal: 2, logicalBytesTotal: 42 },
			stream: () => Readable.from([streamBody]),
		});
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(repos.sessionTransfers.getAttempt(started.attempt.id)?.phase).toBe("cancelled");
		expect(service.activeForProcess(process.id)).toBeNull();
	});

	it("closes the export source without replacing cancellation with a stream failure", async () => {
		const { repos, process, service, prepare } = harness();
		const source = new Readable({ read() {} });
		prepare.mockImplementationOnce(async (request) => ({
			manifest: request.manifest,
			preflight: { entriesTotal: 2, logicalBytesTotal: 42 },
			stream: () => source,
		}));
		const createdGrant = await grant(service, process.id);
		const started = service.startAttempt({
			instanceId: process.id,
			grantId: createdGrant.grantId,
			token: createdGrant.rawToken,
		});
		if (started.kind !== "created") throw new Error("Expected attempt");
		await vi.waitFor(() =>
			expect(service.activeForProcess(process.id)?.phase).toBe("ready_to_stream"),
		);
		const output = service.openStream({
			instanceId: process.id,
			grantId: createdGrant.grantId,
			attemptId: started.attempt.id,
			token: createdGrant.rawToken,
		});
		const consuming = (async () => {
			for await (const _chunk of output) {
				/* Drain until cancellation. */
			}
		})();
		const cancelled = expect(consuming).rejects.toThrow();
		service.cancelForWeb(process.id, started.attempt.id);
		await cancelled;

		expect(source.destroyed).toBe(true);
		expect(repos.sessionTransfers.getAttempt(started.attempt.id)).toMatchObject({
			phase: "cancelled",
			failureCode: "operator_cancelled",
		});
		expect(service.activeForProcess(process.id)).toBeNull();
	});

	it("deletes expired grants without active attempts", () => {
		const { repos, process } = harness();
		const created = repos.sessionTransfers.createGrant({
			instanceId: process.id,
			now: new Date("2026-09-01T00:00:00.000Z"),
			lifetimeMs: 1_000,
		});
		repos.sessionTransfers.cleanup(new Date("2026-09-01T00:00:02.000Z"));
		expect(repos.sessionTransfers.getGrant(created.grant.id)).toBeNull();
	});

	it("retains an expired grant while its accepted attempt is still active", () => {
		const { repos, process } = harness();
		const acceptedAt = new Date("2026-09-01T00:00:00.000Z");
		const created = repos.sessionTransfers.createGrant({
			instanceId: process.id,
			now: acceptedAt,
			lifetimeMs: 1_000,
		});
		const started = repos.sessionTransfers.startAttempt({
			instanceId: process.id,
			grantId: created.grant.id,
			token: created.rawToken,
			now: acceptedAt,
			leaseMs: 90_000,
			hardDeadlineMs: 3_600_000,
		});
		expect(started.kind).toBe("created");
		repos.sessionTransfers.cleanup(new Date("2026-09-01T00:00:02.000Z"));
		expect(repos.sessionTransfers.getGrant(created.grant.id)).not.toBeNull();
	});

	it("accepts one credential-scoped helper preflight and relays its upload", async () => {
		const { process, service, prepare, createdHelperRelays } = harness("waiting", false, true);
		const createdGrant = await grant(service, process.id);
		const started = service.startAttempt({
			instanceId: process.id,
			grantId: createdGrant.grantId,
			token: createdGrant.rawToken,
		});
		if (started.kind !== "created") throw new Error("Expected attempt");
		await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
		const request = prepare.mock.calls[0]?.[0];
		const helper = createdHelperRelays[0];
		if (!request || !helper) throw new Error("Expected helper relay");
		expect(service.helperSpec({ exportId: helper.exportId, credential: "wrong" })).toBeNull();
		expect(
			service.helperSpec({ exportId: helper.exportId, credential: helper.credential }),
		).toEqual({
			manifest: request.manifest,
			limits: expect.objectContaining({ maxEntries: expect.any(Number) }),
		});
		await expect(
			service.reportHelperPreflight({
				exportId: helper.exportId,
				credential: "wrong",
				report: {},
			}),
		).resolves.toBe(false);
		const preflightAccepted = service.reportHelperPreflight({
			exportId: helper.exportId,
			credential: helper.credential,
			report: {
				manifest: request.manifest,
				preflight: { entriesTotal: 3, logicalBytesTotal: 42 },
			},
		});
		await vi.waitFor(() =>
			expect(service.activeForProcess(process.id)?.phase).toBe("ready_to_stream"),
		);
		const auth = {
			instanceId: process.id,
			grantId: createdGrant.grantId,
			attemptId: started.attempt.id,
			token: createdGrant.rawToken,
		};
		const delivered: Buffer[] = [];
		const output = service.openStream(auth);
		const consuming = (async () => {
			for await (const chunk of output) delivered.push(Buffer.from(chunk));
		})();
		await expect(preflightAccepted).resolves.toBe(true);
		const upload = new Readable({ read() {} });
		expect(
			service.acceptHelperStream({
				exportId: helper.exportId,
				credential: helper.credential,
				stream: upload,
			}),
		).toBe(true);
		upload.push(Buffer.from("helper archive"));
		upload.push(null);
		await consuming;
		expect(Buffer.concat(delivered).toString()).toBe("helper archive");
		expect(service.heartbeat(auth)).toMatchObject({
			state: "awaiting_ack",
			phase: "awaiting_ack",
			compressedBytes: 14,
		});
	});

	it("does not open an expired stream even before the periodic sweep", async () => {
		const { repos, process, service } = harness();
		const createdGrant = await grant(service, process.id);
		const started = service.startAttempt({
			instanceId: process.id,
			grantId: createdGrant.grantId,
			token: createdGrant.rawToken,
		});
		if (started.kind !== "created") throw new Error("Expected attempt");
		await vi.waitFor(() =>
			expect(service.activeForProcess(process.id)?.phase).toBe("ready_to_stream"),
		);
		repos.sessionTransfers.updateAttempt(started.attempt.id, {
			leaseUntil: new Date(Date.now() - 1_000).toISOString(),
		});
		const auth = {
			instanceId: process.id,
			grantId: createdGrant.grantId,
			attemptId: started.attempt.id,
			token: createdGrant.rawToken,
		};
		expect(() => service.openStream(auth)).toThrow("transfer_stream_unavailable");
		expect(service.activeForProcess(process.id)).toBeNull();
	});

	it("records the delivered stream digest before idempotent acknowledgement", async () => {
		const { process, service, streamBody } = harness();
		const createdGrant = await grant(service, process.id);
		const started = service.startAttempt({
			instanceId: process.id,
			grantId: createdGrant.grantId,
			token: createdGrant.rawToken,
		});
		if (started.kind !== "created") throw new Error("Expected attempt");
		await vi.waitFor(() =>
			expect(service.activeForProcess(process.id)?.phase).toBe("ready_to_stream"),
		);
		const input = {
			instanceId: process.id,
			grantId: createdGrant.grantId,
			attemptId: started.attempt.id,
			token: createdGrant.rawToken,
		};
		const chunks: Buffer[] = [];
		for await (const chunk of service.openStream(input)) chunks.push(Buffer.from(chunk));
		expect(Buffer.concat(chunks)).toEqual(streamBody);
		const delivered = service.heartbeat(input);
		expect(delivered).toMatchObject({ state: "awaiting_ack", compressedBytes: streamBody.length });
		expect(delivered?.streamSha256).toMatch(/^[a-f0-9]{64}$/);
		expect(service.cancelForWeb(process.id, started.attempt.id)?.state).toBe("awaiting_ack");
		expect(service.acknowledge(input)?.state).toBe("consumed");
		expect(service.acknowledge(input)?.state).toBe("consumed");
		expect(service.activeForProcess(process.id)).toBeNull();
	});
});
