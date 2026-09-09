import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	WORKER_IPC_SERVER_URL_ENV,
	WORKER_SESSION_SNAPSHOT_REASON_HEADER,
	WORKER_SESSION_SNAPSHOT_TURN_RECORD_ID_HEADER,
	WORKER_SESSION_SNAPSHOT_WORKER_ID_HEADER,
	WORKER_SNAPSHOT_TOKEN_ENV,
} from "@leitwerk-dev/worker-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkerSessionSnapshotExchangeFromEnv } from "./session-snapshot-exchange.js";

const tempRoots: string[] = [];

async function createTempRoot(): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), "leitwerk-worker-snapshot-"));
	tempRoots.push(root);
	return root;
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
	let body = "";
	for await (const chunk of request) {
		body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
	}
	return body;
}

async function listen(
	handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
): Promise<{ url: string; close(): Promise<void> }> {
	const server = createServer((request, response) => {
		void Promise.resolve(handler(request, response)).catch((error) => {
			response.statusCode = 500;
			response.end(error instanceof Error ? error.message : String(error));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("expected TCP test server");
	}
	return {
		url: `http://127.0.0.1:${address.port}`,
		close: () =>
			new Promise<void>((resolve, reject) =>
				server.close((err) => (err ? reject(err) : resolve())),
			),
	};
}

function snapshotEnv(serverUrl: string): NodeJS.ProcessEnv {
	return {
		[WORKER_IPC_SERVER_URL_ENV]: serverUrl,
		[WORKER_SNAPSHOT_TOKEN_ENV]: "secret-token",
	};
}

afterEach(async () => {
	for (const root of tempRoots.splice(0)) {
		await rm(root, { recursive: true, force: true });
	}
});

describe("worker session snapshot exchange", () => {
	it.each([
		"http:",
		"ws:",
	])("uploads a snapshot with worker auth and turn metadata through %s", async (protocol) => {
		const root = await createTempRoot();
		const treeFile = path.join(root, "primary.jsonl");
		const content = `${JSON.stringify({ type: "message", id: "entry-upload", text: "Grüße 🌍" })}\n`;
		await writeFile(treeFile, content, "utf8");
		let uploadedBody = "";
		let uploadedReason: string | string[] | undefined;
		let uploadedTurnRecordId: string | string[] | undefined;
		const server = await listen(async (request, response) => {
			expect(request.method).toBe("PUT");
			expect(request.url).toBe("/internal/workers/agt_1/session-snapshot");
			expect(request.headers.authorization).toBe("Bearer secret-token");
			expect(request.headers[WORKER_SESSION_SNAPSHOT_WORKER_ID_HEADER]).toBe("wkr_1");
			uploadedReason = request.headers[WORKER_SESSION_SNAPSHOT_REASON_HEADER];
			uploadedTurnRecordId = request.headers[WORKER_SESSION_SNAPSHOT_TURN_RECORD_ID_HEADER];
			uploadedBody = await readRequestBody(request);
			response.statusCode = 204;
			response.end();
		});
		try {
			const exchange = createWorkerSessionSnapshotExchangeFromEnv({
				env: snapshotEnv(server.url.replace("http:", protocol)),
				instanceId: "agt_1",
				workerId: "wkr_1",
			});

			expect(
				await exchange.uploadSnapshot(treeFile, "before_turn_outcome", {
					turnRecordId: "trn_1",
				}),
			).toEqual({
				kind: "uploaded",
				bytes: Buffer.byteLength(content, "utf8"),
			});
			expect(uploadedBody).toBe(content);
			expect(uploadedReason).toBe("before_turn_outcome");
			expect(uploadedTurnRecordId).toBe("trn_1");
		} finally {
			await server.close();
		}
	});

	it("times out when the server does not respond", async () => {
		const treeFile = path.join(await createTempRoot(), "primary.jsonl");
		await writeFile(treeFile, "snapshot");
		const server = await listen(() => {});
		try {
			const exchange = createWorkerSessionSnapshotExchangeFromEnv({
				env: snapshotEnv(server.url),
				instanceId: "agt_1",
				workerId: "wkr_1",
				timeoutMs: 50,
			});
			await expect(exchange.uploadSnapshot(treeFile, "ready")).rejects.toMatchObject({
				name: "TimeoutError",
			});
		} finally {
			await server.close();
		}
	});

	it("skips uploads when the local snapshot is missing or empty", async () => {
		const root = await createTempRoot();
		const missingTreeFile = path.join(root, "missing.jsonl");
		const emptyTreeFile = path.join(root, "empty.jsonl");
		await writeFile(emptyTreeFile, "", "utf8");
		let requestCount = 0;
		const server = await listen((_request, response) => {
			requestCount += 1;
			response.statusCode = 500;
			response.end("unexpected request");
		});
		try {
			const exchange = createWorkerSessionSnapshotExchangeFromEnv({
				env: snapshotEnv(server.url),
				instanceId: "agt_1",
				workerId: "wkr_1",
			});

			expect(await exchange.uploadSnapshot(missingTreeFile, "ready")).toEqual({
				kind: "missing",
			});
			expect(await exchange.uploadSnapshot(emptyTreeFile, "ready")).toEqual({
				kind: "empty",
			});
			expect(requestCount).toBe(0);
		} finally {
			await server.close();
		}
	});
});
