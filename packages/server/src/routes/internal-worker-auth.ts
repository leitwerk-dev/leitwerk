import type { FastifyReply, FastifyRequest } from "fastify";
import type { RepositoryBundle } from "../db/repositories.js";
import { isSafeSessionInstanceId } from "../process-session-store.js";
import { verifyWorkerConnectToken } from "../supervisor/worker-connect-token.js";
import { parseBearerToken } from "./bearer-token.js";

export function headerValue(value: string | string[] | undefined): string | null {
	return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

export function authenticateActiveWorker(input: {
	request: FastifyRequest;
	reply: FastifyReply;
	instanceId: string;
	workerIdHeader: string;
	leases: Pick<RepositoryBundle, "leases">["leases"];
	operation: string;
}): { workerId: string } | null {
	if (!isSafeSessionInstanceId(input.instanceId)) {
		input.reply.code(400).send({ error: "Invalid process instance id" });
		return null;
	}
	const workerId = headerValue(input.request.headers[input.workerIdHeader]);
	const token = parseBearerToken(input.request.headers.authorization);
	if (!workerId || !token) {
		input.reply.code(401).send({ error: `Worker ${input.operation} authentication required` });
		return null;
	}
	const lease = input.leases.getByInstance(input.instanceId);
	if (
		!lease ||
		lease.workerId !== workerId ||
		lease.state === "failed" ||
		lease.state === "exited"
	) {
		input.reply.code(409).send({ error: `${input.operation} is not from the active worker lease` });
		return null;
	}
	if (!lease.snapshotTokenHash || !verifyWorkerConnectToken(token, lease.snapshotTokenHash)) {
		input.reply.code(403).send({ error: `Invalid worker ${input.operation} token` });
		return null;
	}
	return { workerId };
}
