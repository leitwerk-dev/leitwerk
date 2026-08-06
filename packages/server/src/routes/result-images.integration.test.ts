import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WORKER_RESULT_IMAGE_WORKER_ID_HEADER } from "@leitwerk-dev/worker-protocol";
import Fastify, { type FastifyInstance } from "fastify";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { createInMemoryDatabase } from "../db/database.js";
import { createAllRepos } from "../db/repositories.js";
import { createProcessOperationCoordinator } from "../process-operation-coordinator.js";
import { ResultImageStore } from "../result-image-store.js";
import {
	createWorkerConnectToken,
	hashWorkerConnectToken,
} from "../supervisor/worker-connect-token.js";
import type { RouteDeps } from "./process-route-helpers.js";
import { registerResultImageRoutes } from "./result-images.js";

const PNG = await sharp({
	create: { width: 2, height: 2, channels: 4, background: { r: 20, g: 40, b: 60, alpha: 1 } },
})
	.png()
	.toBuffer();
const tempRoots: string[] = [];

async function createHarness(options?: { installParser?: (app: FastifyInstance) => void }) {
	const app = Fastify({ logger: false });
	const repos = createAllRepos(createInMemoryDatabase());
	const process = repos.processes.create({ processId: "test_process", lifecycleStatus: "active" });
	const token = createWorkerConnectToken();
	const lease = repos.leases.create({
		instanceId: process.id,
		workerId: "wkr_1",
		state: "busy",
		serverEpoch: "epoch-1",
		snapshotTokenHash: hashWorkerConnectToken(token),
	});
	const start = repos.turnStarts.create({
		id: "tsr_result_image",
		instanceId: process.id,
		turnId: "implementation",
		turnType: "llm",
		proposedTurnRecordId: "trn_result_image",
		startKind: "selected_turn",
		recoveryTurnRecordId: null,
		continuation: null,
		state: {
			kind: "accepted",
			start: {
				kind: "llm",
				model: {
					profileId: "profile_result_image",
					providerId: "provider_result_image",
					modelId: "model_result_image",
					thinkingLevel: "low",
				},
				providerOptions: {},
				providerWorkerConfig: null,
				piResourceSnapshotDigest: "digest_result_image",
				workerRuntimeProfileId: "local",
				piSettings: {},
			},
			turnRecordId: "trn_result_image",
			acceptedWorkerLeaseId: lease.id,
		},
	});
	const turn = repos.turnRecords.create({
		id: "trn_result_image",
		instanceId: process.id,
		turnId: "implementation",
		status: "running",
		pathType: "primary",
		turnStartRecordId: start.id,
		acceptedWorkerLeaseId: lease.id,
	});
	repos.processes.update(process.id, { currentExecution: { kind: "worker_start", id: start.id } });
	options?.installParser?.(app);
	const root = await mkdtemp(path.join(tmpdir(), "leitwerk-result-image-route-"));
	tempRoots.push(root);
	const store = new ResultImageStore({ rootDir: root });
	const processOperations = createProcessOperationCoordinator();
	registerResultImageRoutes({
		app,
		deps: {
			processes: repos.processes,
			turnRecords: repos.turnRecords,
			turnStarts: repos.turnStarts,
			leases: repos.leases,
			processOperations,
		} as RouteDeps,
		store,
	});
	return { app, repos, process, turn, token, store, processOperations };
}

function uploadHeaders(token: string) {
	return {
		authorization: `Bearer ${token}`,
		[WORKER_RESULT_IMAGE_WORKER_ID_HEADER]: "wkr_1",
		"content-type": "application/octet-stream",
	};
}

afterEach(async () => {
	for (const root of tempRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("result image routes", () => {
	it("uploads and serves a correlated image with hardened response headers", async () => {
		const { app, process, turn, token } = await createHarness();
		const upload = await app.inject({
			method: "POST",
			url: `/internal/workers/${process.id}/turn-records/${turn.id}/result-images`,
			headers: uploadHeaders(token),
			payload: PNG,
		});

		expect(upload.statusCode).toBe(201);
		const metadata = upload.json<{ url: string; mimeType: string; byteSize: number }>();
		expect(metadata).toMatchObject({ mimeType: "image/png", byteSize: PNG.length });
		const retry = await app.inject({
			method: "POST",
			url: `/internal/workers/${process.id}/turn-records/${turn.id}/result-images`,
			headers: uploadHeaders(token),
			payload: PNG,
		});
		expect(retry.statusCode).toBe(201);
		expect(retry.json<{ url: string }>().url).toBe(metadata.url);
		const get = await app.inject({ method: "GET", url: metadata.url });
		expect(get.statusCode).toBe(200);
		expect(get.headers).toMatchObject({
			"content-type": "image/png",
			"x-content-type-options": "nosniff",
			"content-security-policy": "default-src 'none'; sandbox",
			"cache-control": "private, no-store",
		});
		expect(get.rawPayload).toEqual(PNG);
		await app.close();
	});

	it("authenticates before buffering and enforces turn correlation", async () => {
		const { app, repos, process, turn, token } = await createHarness();
		const url = `/internal/workers/${process.id}/turn-records/${turn.id}/result-images`;
		expect(
			(
				await app.inject({
					method: "POST",
					url,
					headers: { "content-type": "application/octet-stream" },
					payload: Buffer.alloc(2048),
				})
			).statusCode,
		).toBe(401);
		const otherStart = repos.turnStarts.create({
			id: "tsr_other",
			instanceId: process.id,
			turnId: "implementation",
			turnType: "llm",
			proposedTurnRecordId: "trn_other",
			startKind: "selected_turn",
			recoveryTurnRecordId: null,
			continuation: null,
			state: { kind: "superseded", start: null },
		});
		repos.processes.update(process.id, {
			currentExecution: { kind: "worker_start", id: otherStart.id },
		});
		expect(
			(
				await app.inject({
					method: "POST",
					url,
					headers: uploadHeaders(token),
					payload: PNG,
				})
			).statusCode,
		).toBe(409);
		await app.close();
	});

	it("rejects a worker lease replaced while the image body is being decoded", async () => {
		let parserEntered!: () => void;
		const entered = new Promise<void>((resolve) => {
			parserEntered = resolve;
		});
		let releaseParser!: () => void;
		const parserGate = new Promise<void>((resolve) => {
			releaseParser = resolve;
		});
		const { app, repos, process, turn, token } = await createHarness({
			installParser: (server) => {
				server.addContentTypeParser(
					"application/octet-stream",
					{ parseAs: "buffer" },
					(_request, body, done) => {
						parserEntered();
						void parserGate.then(() => done(null, body));
					},
				);
			},
		});
		const upload = app.inject({
			method: "POST",
			url: `/internal/workers/${process.id}/turn-records/${turn.id}/result-images`,
			headers: uploadHeaders(token),
			payload: PNG,
		});
		await entered;
		const oldLease = repos.leases.getByInstance(process.id);
		if (!oldLease) throw new Error("Expected active worker lease");
		repos.leases.update(oldLease.id, { state: "exited", exitedAt: new Date().toISOString() });
		const replacementToken = createWorkerConnectToken();
		repos.leases.create({
			instanceId: process.id,
			workerId: "wkr_2",
			state: "busy",
			serverEpoch: "epoch-1",
			snapshotTokenHash: hashWorkerConnectToken(replacementToken),
		});
		releaseParser();

		expect((await upload).statusCode).toBe(409);
		await app.close();
	});

	it("holds process coordination through the image write", async () => {
		const { app, repos, process, turn, token, store, processOperations } = await createHarness();
		let enteredPut!: () => void;
		const putEntered = new Promise<void>((resolve) => {
			enteredPut = resolve;
		});
		let releasePut!: () => void;
		const putGate = new Promise<void>((resolve) => {
			releasePut = resolve;
		});
		const originalPut = store.put.bind(store);
		store.put = async (input) => {
			enteredPut();
			await putGate;
			return originalPut(input);
		};

		const upload = app.inject({
			method: "POST",
			url: `/internal/workers/${process.id}/turn-records/${turn.id}/result-images`,
			headers: uploadHeaders(token),
			payload: PNG,
		});
		await putEntered;
		let turnFinished = false;
		const finishTurn = processOperations.runExclusive(process.id, () => {
			turnFinished = true;
			repos.processes.update(process.id, { currentExecution: null });
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(turnFinished).toBe(false);

		releasePut();
		expect((await upload).statusCode).toBe(201);
		await finishTurn;
		expect(turnFinished).toBe(true);
		await app.close();
	});
});
