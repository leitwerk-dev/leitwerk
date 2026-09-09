import {
	buildManagedResultImagePath,
	RESULT_IMAGE_MAX_SIZE_BYTES,
	WORKER_RESULT_IMAGE_WORKER_ID_HEADER,
} from "@leitwerk-dev/worker-protocol";
import type { FastifyInstance } from "fastify";
import { resolveCurrentExecutionTurnRecordId } from "../process-execution.js";
import type { ResultImageStore } from "../result-image-store.js";
import { validateResultImage } from "../result-image-validation.js";
import { authenticateActiveWorker } from "./internal-worker-auth.js";
import type { RouteDeps } from "./process-route-helpers.js";

export function registerResultImageRoutes(input: {
	app: FastifyInstance;
	deps: RouteDeps;
	store: ResultImageStore;
}): void {
	if (!input.app.hasContentTypeParser("application/octet-stream"))
		input.app.addContentTypeParser(
			"application/octet-stream",
			{ parseAs: "buffer", bodyLimit: RESULT_IMAGE_MAX_SIZE_BYTES },
			(_request, body, done) => done(null, body),
		);
	input.app.post<{ Params: { instanceId: string; turnRecordId: string }; Body: Buffer }>(
		"/internal/workers/:instanceId/turn-records/:turnRecordId/result-images",
		{
			bodyLimit: RESULT_IMAGE_MAX_SIZE_BYTES,
			onRequest: async (request, reply) => {
				const auth = authenticateActiveWorker({
					request,
					reply,
					instanceId: request.params.instanceId,
					leases: input.deps.leases,
					workerIdHeader: WORKER_RESULT_IMAGE_WORKER_ID_HEADER,
					operation: "result image upload",
				});
				if (!auth) return reply;
			},
		},
		async (request, reply) => {
			const { instanceId, turnRecordId } = request.params;
			if (!Buffer.isBuffer(request.body) || request.body.length === 0)
				return reply.code(400).send({ error: "Result image body is required" });
			const validation = await validateResultImage(request.body);
			if (!validation.ok) return reply.code(415).send({ error: validation.error });
			const result = await input.deps.processOperations.runExclusive(instanceId, async () => {
				// Image decoding happens after onRequest authentication. Re-check under
				// process coordination so a replaced worker cannot commit stale bytes.
				if (
					!authenticateActiveWorker({
						request,
						reply,
						instanceId,
						leases: input.deps.leases,
						workerIdHeader: WORKER_RESULT_IMAGE_WORKER_ID_HEADER,
						operation: "result image upload",
					})
				)
					return null;
				const process = input.deps.processes.getById(instanceId);
				const turn = input.deps.turnRecords.getById(turnRecordId);
				const expectedTurnRecordId = resolveCurrentExecutionTurnRecordId(
					process,
					input.deps.turnStarts,
				);
				if (
					!process ||
					expectedTurnRecordId !== turnRecordId ||
					!turn ||
					turn.instanceId !== instanceId ||
					turn.status !== "running"
				)
					return null;
				return input.store.put({
					instanceId,
					turnRecordId,
					bytes: request.body,
					mimeType: validation.mimeType,
				});
			});
			if (!result) {
				if (reply.sent) return reply;
				return reply
					.code(409)
					.send({ error: "Result image does not match the running process turn" });
			}
			return reply.code(201).send({
				...result,
				url: buildManagedResultImagePath(instanceId, turnRecordId, result.imageId),
			});
		},
	);
	input.app.get<{ Params: { instanceId: string; turnRecordId: string; imageId: string } }>(
		"/api/processes/:instanceId/turn-records/:turnRecordId/result-images/:imageId",
		async (request, reply) => {
			const { instanceId, turnRecordId, imageId } = request.params;
			const turn = input.deps.turnRecords.getById(turnRecordId);
			if (!input.deps.processes.getById(instanceId) || !turn || turn.instanceId !== instanceId)
				return reply.code(404).send({ error: "Result image not found" });
			const stored = await input.store.get(instanceId, turnRecordId, imageId);
			if (!stored) return reply.code(404).send({ error: "Result image not found" });
			reply.headers({
				"content-type": stored.metadata.mimeType,
				"x-content-type-options": "nosniff",
				"content-security-policy": "default-src 'none'; sandbox",
				"cache-control": "private, no-store",
			});
			return reply.send(stored.bytes);
		},
	);
}
