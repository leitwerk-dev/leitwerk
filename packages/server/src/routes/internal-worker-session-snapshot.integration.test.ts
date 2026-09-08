import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	createCanonicalPiResourceBundle,
	WORKER_SESSION_SNAPSHOT_CONTENT_TYPE,
	WORKER_SESSION_SNAPSHOT_REASON_HEADER,
	WORKER_SESSION_SNAPSHOT_TURN_RECORD_ID_HEADER,
	WORKER_SESSION_SNAPSHOT_WORKER_ID_HEADER,
} from "@leitwerk-dev/worker-protocol";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createInMemoryDatabase } from "../db/database.js";
import { createAllRepos } from "../db/repositories.js";
import { createFileBackedProcessSessionSnapshotStore } from "../process-session-store.js";
import {
	createWorkerConnectToken,
	hashWorkerConnectToken,
} from "../supervisor/worker-connect-token.js";
import { registerInternalWorkerSessionSnapshotRoutes } from "./internal-worker-session-snapshot.js";

const tempRoots: string[] = [];

async function createTempRoot(): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), "leitwerk-snapshot-route-"));
	tempRoots.push(root);
	return root;
}

async function createHarness(maxSnapshotBytes = 64) {
	const app = Fastify({ logger: false });
	const db = createInMemoryDatabase();
	const repos = createAllRepos(db);
	const process = repos.processes.create({ processId: "test_process", lifecycleStatus: "active" });
	const token = createWorkerConnectToken();
	repos.leases.create({
		instanceId: process.id,
		workerId: "wkr_1",
		state: "idle",
		serverEpoch: "epoch-1",
		snapshotTokenHash: hashWorkerConnectToken(token),
	});
	const sessionSnapshots = createFileBackedProcessSessionSnapshotStore(await createTempRoot());
	registerInternalWorkerSessionSnapshotRoutes({
		app,
		leases: repos.leases,
		processes: repos.processes,
		turnStarts: repos.turnStarts,
		turnRecords: repos.turnRecords,
		skills: repos.skills,
		sessionSnapshots,
		maxSnapshotBytes,
	});
	return { app, repos, process, sessionSnapshots, token };
}

function seedAcceptedAutomaticTurn(
	repos: ReturnType<typeof createAllRepos>,
	processId: string,
	turnRecordId: string,
	status: "running" | "failed" = "running",
): void {
	const lease = repos.leases.getByInstance(processId);
	if (!lease) throw new Error("expected lease");
	const start = repos.turnStarts.create({
		id: `tsr_${turnRecordId}`,
		instanceId: processId,
		turnId: "test_turn",
		turnType: "automatic",
		proposedTurnRecordId: turnRecordId,
		startKind: "selected_turn",
		recoveryTurnRecordId: null,
		continuation: null,
		state: {
			kind: "accepted",
			start: { kind: "automatic" },
			turnRecordId,
			acceptedWorkerLeaseId: lease.id,
			acceptedAt: new Date().toISOString(),
		},
	});
	repos.turnRecords.create({
		id: turnRecordId,
		instanceId: processId,
		turnId: "test_turn",
		turnType: "automatic",
		turnStartRecordId: start.id,
		acceptedWorkerLeaseId: lease.id,
		status,
		pathType: "primary",
	});
	repos.processes.update(processId, {
		currentExecution: { kind: "worker_start", id: start.id },
	});
}

function snapshotHeaders(input: {
	token: string;
	workerId?: string;
	turnRecordId?: string;
	reason?: string;
}) {
	return {
		authorization: `Bearer ${input.token}`,
		[WORKER_SESSION_SNAPSHOT_WORKER_ID_HEADER]: input.workerId ?? "wkr_1",
		...(input.turnRecordId
			? { [WORKER_SESSION_SNAPSHOT_TURN_RECORD_ID_HEADER]: input.turnRecordId }
			: {}),
		...(input.reason ? { [WORKER_SESSION_SNAPSHOT_REASON_HEADER]: input.reason } : {}),
		"content-type": WORKER_SESSION_SNAPSHOT_CONTENT_TYPE,
	};
}

afterEach(async () => {
	for (const root of tempRoots.splice(0)) {
		await rm(root, { recursive: true, force: true });
	}
});

describe("internal worker session snapshot routes", () => {
	it("atomically overwrites the latest snapshot for a snapshot-token-authenticated active worker", async () => {
		const { app, process, sessionSnapshots, token } = await createHarness();
		const first = `${JSON.stringify({ type: "message", id: "entry-1" })}\n`;
		const second = `${JSON.stringify({ type: "message", id: "entry-2" })}\n`;

		const firstPut = await app.inject({
			method: "PUT",
			url: `/internal/workers/${process.id}/session-snapshot`,
			headers: snapshotHeaders({ token }),
			payload: first,
		});
		const secondPut = await app.inject({
			method: "PUT",
			url: `/internal/workers/${process.id}/session-snapshot`,
			headers: snapshotHeaders({ token }),
			payload: second,
		});

		expect(firstPut.statusCode).toBe(204);
		expect(secondPut.statusCode).toBe(204);
		expect(await sessionSnapshots.readRawSnapshot(process.id)).toBe(second);
		await app.close();
	});

	it("rejects the WebSocket connect token for snapshot authentication", async () => {
		const { app, process } = await createHarness();
		const content = `${JSON.stringify({ ok: true })}\n`;

		const response = await app.inject({
			method: "PUT",
			url: `/internal/workers/${process.id}/session-snapshot`,
			headers: snapshotHeaders({ token: "websocket-token" }),
			payload: content,
		});

		expect(response.statusCode).toBe(403);
		await app.close();
	});

	it("rejects stale workers, replaced-worker tokens, malformed JSONL, and oversized uploads", async () => {
		const { app, process, repos, sessionSnapshots, token } = await createHarness();
		const content = `${JSON.stringify({ n: 1 })}\n`;

		const staleWorker = await app.inject({
			method: "PUT",
			url: `/internal/workers/${process.id}/session-snapshot`,
			headers: snapshotHeaders({ token, workerId: "wkr_old" }),
			payload: content,
		});
		const malformed = await app.inject({
			method: "PUT",
			url: `/internal/workers/${process.id}/session-snapshot`,
			headers: snapshotHeaders({ token }),
			payload: "not-json\n",
		});
		const oversized = await app.inject({
			method: "PUT",
			url: `/internal/workers/${process.id}/session-snapshot`,
			headers: snapshotHeaders({ token }),
			payload: `${JSON.stringify({ value: "x".repeat(100) })}\n`,
		});
		const lease = repos.leases.getByInstance(process.id);
		if (!lease) throw new Error("expected lease");
		const replacementToken = createWorkerConnectToken();
		repos.leases.update(lease.id, { exitedAt: new Date().toISOString() });
		repos.leases.create({
			instanceId: process.id,
			workerId: "wkr_2",
			state: "idle",
			serverEpoch: "epoch-1",
			snapshotTokenHash: hashWorkerConnectToken(replacementToken),
		});
		const oldWorkerAfterReplacement = await app.inject({
			method: "PUT",
			url: `/internal/workers/${process.id}/session-snapshot`,
			headers: snapshotHeaders({ token, workerId: "wkr_1" }),
			payload: content,
		});

		expect(staleWorker.statusCode).toBe(409);
		expect(malformed.statusCode).toBe(400);
		expect(oversized.statusCode).toBe(413);
		expect(oldWorkerAfterReplacement.statusCode).toBe(409);
		expect(await sessionSnapshots.readRawSnapshot(process.id)).toBeNull();
		await app.close();
	});

	it("requires the supplied turn record id to match the process current turn", async () => {
		const { app, process, repos, sessionSnapshots, token } = await createHarness();
		const content = `${JSON.stringify({ n: 1 })}\n`;
		seedAcceptedAutomaticTurn(repos, process.id, "trn_current");

		const missingTurn = await app.inject({
			method: "PUT",
			url: `/internal/workers/${process.id}/session-snapshot`,
			headers: snapshotHeaders({ token }),
			payload: content,
		});
		const wrongTurn = await app.inject({
			method: "PUT",
			url: `/internal/workers/${process.id}/session-snapshot`,
			headers: snapshotHeaders({ token, turnRecordId: "trn_old" }),
			payload: content,
		});
		const matchingTurn = await app.inject({
			method: "PUT",
			url: `/internal/workers/${process.id}/session-snapshot`,
			headers: snapshotHeaders({ token, turnRecordId: "trn_current" }),
			payload: content,
		});

		expect(missingTurn.statusCode).toBe(409);
		expect(wrongTurn.statusCode).toBe(409);
		expect(matchingTurn.statusCode).toBe(204);
		expect(await sessionSnapshots.readRawSnapshot(process.id)).toBe(content);
		await app.close();
	});

	it("records managed skill reads with their session timestamp", async () => {
		const { app, process, repos, token } = await createHarness(2_048);
		const bundle = createCanonicalPiResourceBundle([
			{ path: "skills/review/SKILL.md", content: Buffer.from("# Review") },
		]);
		repos.skills.reconcile([
			{
				skillId: "review",
				label: "Review",
				description: null,
				bundle,
				sourceRevision: null,
			},
		]);
		repos.processSkills.attach(process.id, repos.skills.resolveActive(["review"]));
		seedAcceptedAutomaticTurn(repos, process.id, "trn_current");
		const lease = repos.leases.getByInstance(process.id);
		if (!lease) throw new Error("expected lease");
		const invokedAt = new Date(Date.now() + 1_000).toISOString();
		const content = `${JSON.stringify({
			type: "message",
			timestamp: invokedAt,
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						name: "read",
						arguments: {
							path: `/managed/${process.id}/${lease.id}/skills/review/SKILL.md`,
						},
					},
				],
			},
		})}\n`;

		const response = await app.inject({
			method: "PUT",
			url: `/internal/workers/${process.id}/session-snapshot`,
			headers: snapshotHeaders({ token, turnRecordId: "trn_current" }),
			payload: content,
		});

		expect(response.statusCode).toBe(204);
		const detail = repos.skills.getInstalledDetail("review");
		expect(detail?.usage.invokedAllTime).toBe(1);
		expect(detail?.processes[0]?.lastInvokedAt).toBe(invokedAt);
		await app.close();
	});

	it("accepts an uncorrelated final snapshot while the active worker is draining", async () => {
		const { app, process, repos, sessionSnapshots, token } = await createHarness();
		const content = `${JSON.stringify({ n: 1 })}\n`;
		seedAcceptedAutomaticTurn(repos, process.id, "trn_failed", "failed");
		const lease = repos.leases.getByInstance(process.id);
		if (!lease) throw new Error("expected lease");
		repos.leases.update(lease.id, { state: "draining" });

		const response = await app.inject({
			method: "PUT",
			url: `/internal/workers/${process.id}/session-snapshot`,
			headers: snapshotHeaders({ token, reason: "before_cleanup_completed" }),
			payload: content,
		});

		expect(response.statusCode).toBe(204);
		expect(await sessionSnapshots.readRawSnapshot(process.id)).toBe(content);
		await app.close();
	});
});
