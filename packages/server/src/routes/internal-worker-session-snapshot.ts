import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import {
	WORKER_SESSION_SNAPSHOT_CONTENT_TYPE,
	WORKER_SESSION_SNAPSHOT_REASON_HEADER,
	WORKER_SESSION_SNAPSHOT_TURN_RECORD_ID_HEADER,
	WORKER_SESSION_SNAPSHOT_WORKER_ID_HEADER,
} from "@leitwerk-dev/worker-protocol";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RepositoryBundle } from "../db/repositories.js";
import type { ProcessSessionSnapshotStore } from "../process-session-store.js";
import { detectSkillInvocations } from "../skills/invocation-detector.js";
import { authenticateActiveWorker, headerValue } from "./internal-worker-auth.js";

const DEFAULT_SESSION_SNAPSHOT_BODY_LIMIT_BYTES = 128 * 1024 * 1024;

interface ParsedSnapshotBody {
	path: string;
}

function validateJsonLine(line: string, lineNumber: number): string | null {
	if (line.trim() === "") return null;
	try {
		JSON.parse(line);
		return null;
	} catch {
		return `Session snapshot line ${lineNumber} is not valid JSON`;
	}
}

async function streamSnapshotToTempFile(
	payload: Readable,
	bodyLimit: number,
): Promise<ParsedSnapshotBody> {
	const dir = await mkdtemp(path.join(tmpdir(), "leitwerk-session-snapshot-"));
	const file = path.join(dir, "snapshot.jsonl");
	let bytes = 0;
	const decoder = new StringDecoder("utf8");
	let pendingLine = "";
	let lineNumber = 1;
	try {
		for await (const chunk of payload) {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			bytes += buffer.length;
			if (bytes > bodyLimit) {
				throw Object.assign(new Error("Session snapshot exceeds the configured maximum size"), {
					statusCode: 413,
				});
			}
			await writeFile(file, buffer, { flag: "a" });
			const text = decoder.write(buffer);
			pendingLine += text;
			let newlineIndex = pendingLine.search(/\r?\n/);
			while (newlineIndex >= 0) {
				const line = pendingLine.slice(0, newlineIndex);
				const error = validateJsonLine(line, lineNumber);
				if (error) throw Object.assign(new Error(error), { statusCode: 400 });
				pendingLine = pendingLine.slice(
					pendingLine[newlineIndex] === "\r" && pendingLine[newlineIndex + 1] === "\n"
						? newlineIndex + 2
						: newlineIndex + 1,
				);
				lineNumber += 1;
				newlineIndex = pendingLine.search(/\r?\n/);
			}
		}
		pendingLine += decoder.end();
		const finalLineError = validateJsonLine(pendingLine, lineNumber);
		if (finalLineError) throw Object.assign(new Error(finalLineError), { statusCode: 400 });
		return { path: file };
	} catch (error) {
		await rm(dir, { recursive: true, force: true });
		throw error;
	}
}

function registerSnapshotContentTypeParser(app: FastifyInstance, bodyLimit: number): void {
	if (!app.hasContentTypeParser(WORKER_SESSION_SNAPSHOT_CONTENT_TYPE)) {
		app.addContentTypeParser(WORKER_SESSION_SNAPSHOT_CONTENT_TYPE, (_request, payload, done) => {
			streamSnapshotToTempFile(payload, bodyLimit).then(
				(body) => done(null, body),
				(error) => done(error as Error),
			);
		});
	}
}

function validateTurnRecord(input: {
	request: FastifyRequest;
	reply: FastifyReply;
	instanceId: string;
	processes: Pick<RepositoryBundle, "processes">["processes"];
	turnStarts: Pick<RepositoryBundle, "turnStarts">["turnStarts"];
	leases: Pick<RepositoryBundle, "leases">["leases"];
}): boolean {
	const currentProcess = input.processes.getById(input.instanceId);
	if (!currentProcess) {
		input.reply.code(404).send({ error: "Process instance not found" });
		return false;
	}
	const suppliedTurnRecordId = headerValue(
		input.request.headers[WORKER_SESSION_SNAPSHOT_TURN_RECORD_ID_HEADER],
	);
	const expectedTurnRecordId =
		currentProcess.currentExecution?.kind === "worker_start"
			? (() => {
					const start = input.turnStarts.getById(currentProcess.currentExecution.id);
					return start?.state.kind === "accepted" ? start.state.turnRecordId : null;
				})()
			: null;
	if ((suppliedTurnRecordId ?? null) !== expectedTurnRecordId) {
		const reason = headerValue(input.request.headers[WORKER_SESSION_SNAPSHOT_REASON_HEADER]);
		const lease = input.leases.getByInstance(input.instanceId);
		const isDrainingCleanupSnapshot =
			suppliedTurnRecordId === null &&
			reason === "before_cleanup_completed" &&
			lease?.state === "draining";
		if (isDrainingCleanupSnapshot) return true;
		input.reply
			.code(409)
			.send({ error: "Session snapshot turn record does not match current process turn" });
		return false;
	}
	return true;
}

export function registerInternalWorkerSessionSnapshotRoutes(input: {
	app: FastifyInstance;
	sessionSnapshots: ProcessSessionSnapshotStore;
	leases: Pick<RepositoryBundle, "leases">["leases"];
	processes: Pick<RepositoryBundle, "processes">["processes"];
	turnStarts: Pick<RepositoryBundle, "turnStarts">["turnStarts"];
	turnRecords: Pick<RepositoryBundle, "turnRecords">["turnRecords"];
	skills: Pick<RepositoryBundle, "skills">["skills"];
	maxSnapshotBytes?: number;
}): void {
	const bodyLimit = input.maxSnapshotBytes ?? DEFAULT_SESSION_SNAPSHOT_BODY_LIMIT_BYTES;
	registerSnapshotContentTypeParser(input.app, bodyLimit);

	input.app.put<{ Params: { instanceId: string }; Body: ParsedSnapshotBody }>(
		"/internal/workers/:instanceId/session-snapshot",
		{ bodyLimit },
		async (request, reply) => {
			const { instanceId } = request.params;
			const body = request.body;
			const cleanupBody = async () => {
				if (body?.path) await rm(path.dirname(body.path), { recursive: true, force: true });
			};
			try {
				const auth = authenticateActiveWorker({
					request,
					reply,
					instanceId,
					leases: input.leases,
					workerIdHeader: WORKER_SESSION_SNAPSHOT_WORKER_ID_HEADER,
					operation: "snapshot",
				});
				if (!auth) return reply;
				if (!body || typeof body.path !== "string") {
					reply.code(400).send({ error: "Session snapshot body must be text" });
					return reply;
				}
				if (
					!validateTurnRecord({
						request,
						reply,
						instanceId,
						processes: input.processes,
						turnStarts: input.turnStarts,
						leases: input.leases,
					})
				) {
					return reply;
				}
				// Re-check the active lease immediately before the atomic overwrite so a
				// replaced worker cannot upload after a newer worker has taken the lease.
				if (
					!authenticateActiveWorker({
						request,
						reply,
						instanceId,
						leases: input.leases,
						workerIdHeader: WORKER_SESSION_SNAPSHOT_WORKER_ID_HEADER,
						operation: "snapshot",
					})
				) {
					return reply;
				}
				const turnRecordId = headerValue(
					request.headers[WORKER_SESSION_SNAPSHOT_TURN_RECORD_ID_HEADER],
				);
				if (turnRecordId) {
					const turnRecord = input.turnRecords.getById(turnRecordId);
					if (!turnRecord || turnRecord.instanceId !== instanceId) {
						return reply.code(409).send({ error: "Snapshot turn record was not found" });
					}
					const lease = input.leases.getByInstance(instanceId);
					if (!lease) {
						return reply.code(409).send({ error: "Snapshot has no active worker lease" });
					}
					const invocations = await detectSkillInvocations(body.path, {
						since: turnRecord.startedAt,
						managedAgentDir: { instanceId, leaseId: lease.id },
					});
					input.skills.recordInvocations({ instanceId, turnRecordId, invocations });
				}
				await input.sessionSnapshots.writeSnapshotFile(instanceId, body.path);
				reply.code(204).send();
			} finally {
				await cleanupBody();
			}
			return reply;
		},
	);
}
