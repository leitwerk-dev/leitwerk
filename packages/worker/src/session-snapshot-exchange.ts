import { readFile, stat } from "node:fs/promises";
import { isEnoent } from "@leitwerk-dev/process-sdk";
import {
	buildWorkerSessionSnapshotPath,
	WORKER_IPC_SERVER_URL_ENV,
	WORKER_SESSION_SNAPSHOT_CONTENT_TYPE,
	WORKER_SESSION_SNAPSHOT_REASON_HEADER,
	WORKER_SESSION_SNAPSHOT_TURN_RECORD_ID_HEADER,
	WORKER_SESSION_SNAPSHOT_WORKER_ID_HEADER,
	WORKER_SNAPSHOT_TOKEN_ENV,
} from "@leitwerk-dev/worker-protocol";
import { resolveWorkerHttpUrl } from "./worker-http.js";

export type SessionSnapshotUploadResult =
	| { kind: "disabled" }
	| { kind: "missing" }
	| { kind: "empty" }
	| { kind: "uploaded"; bytes: number };

export interface WorkerSessionSnapshotUploadMetadata {
	turnRecordId?: string | null;
}

export interface WorkerSessionSnapshotExchange {
	uploadSnapshot(
		treeFile: string,
		reason: string,
		metadata?: WorkerSessionSnapshotUploadMetadata,
	): Promise<SessionSnapshotUploadResult>;
}

type FetchLike = typeof fetch;

export function resolveWorkerSessionSnapshotUrl(input: {
	serverUrl: string;
	instanceId: string;
}): string {
	return resolveWorkerHttpUrl(input.serverUrl, buildWorkerSessionSnapshotPath(input.instanceId));
}

async function localFileSize(filePath: string): Promise<number | null> {
	try {
		return (await stat(filePath)).size;
	} catch (error) {
		if (isEnoent(error)) {
			return null;
		}
		throw error;
	}
}

async function fetchWithTimeout(input: {
	fetchImpl: FetchLike;
	url: string;
	init: RequestInit;
	timeoutMs: number;
}): Promise<Response> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
	timeout.unref?.();
	try {
		return await input.fetchImpl(input.url, { ...input.init, signal: controller.signal });
	} finally {
		clearTimeout(timeout);
	}
}

export function createWorkerSessionSnapshotExchange(input: {
	serverUrl: string;
	token: string;
	instanceId: string;
	workerId: string;
	fetchImpl?: FetchLike;
	timeoutMs?: number;
}): WorkerSessionSnapshotExchange {
	const fetchImpl = input.fetchImpl ?? globalThis.fetch;
	if (!fetchImpl) {
		return disabledWorkerSessionSnapshotExchange;
	}
	const timeoutMs = input.timeoutMs ?? 30_000;
	const snapshotUrl = resolveWorkerSessionSnapshotUrl({
		serverUrl: input.serverUrl,
		instanceId: input.instanceId,
	});
	const authHeaders = {
		authorization: `Bearer ${input.token}`,
		[WORKER_SESSION_SNAPSHOT_WORKER_ID_HEADER]: input.workerId,
	};

	return {
		async uploadSnapshot(treeFile, reason, metadata = {}) {
			const size = await localFileSize(treeFile);
			if (size === null) {
				return { kind: "missing" };
			}
			if (size === 0) {
				return { kind: "empty" };
			}
			const content = await readFile(treeFile, "utf8");
			if (content.length === 0) {
				return { kind: "empty" };
			}
			const response = await fetchWithTimeout({
				fetchImpl,
				url: snapshotUrl,
				timeoutMs,
				init: {
					method: "PUT",
					headers: {
						...authHeaders,
						"content-type": WORKER_SESSION_SNAPSHOT_CONTENT_TYPE,
						[WORKER_SESSION_SNAPSHOT_REASON_HEADER]: reason,
						...(metadata.turnRecordId
							? { [WORKER_SESSION_SNAPSHOT_TURN_RECORD_ID_HEADER]: metadata.turnRecordId }
							: {}),
					},
					body: content,
				},
			});
			if (!response.ok) {
				throw new Error(`Session snapshot upload failed with HTTP ${response.status}`);
			}
			return { kind: "uploaded", bytes: Buffer.byteLength(content, "utf8") };
		},
	};
}

export const disabledWorkerSessionSnapshotExchange: WorkerSessionSnapshotExchange = {
	async uploadSnapshot() {
		return { kind: "disabled" };
	},
};

export function createWorkerSessionSnapshotExchangeFromEnv(input: {
	env?: NodeJS.ProcessEnv;
	instanceId: string;
	workerId: string;
	fetchImpl?: FetchLike;
	timeoutMs?: number;
}): WorkerSessionSnapshotExchange {
	const env = input.env ?? process.env;
	const serverUrl = env[WORKER_IPC_SERVER_URL_ENV];
	const token = env[WORKER_SNAPSHOT_TOKEN_ENV];
	if (!serverUrl || !token) {
		return disabledWorkerSessionSnapshotExchange;
	}
	return createWorkerSessionSnapshotExchange({
		serverUrl,
		token,
		instanceId: input.instanceId,
		workerId: input.workerId,
		fetchImpl: input.fetchImpl,
		timeoutMs: input.timeoutMs,
	});
}
