import type { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { SESSION_TRANSFER_CONTENT_TYPE } from "@leitwerk-dev/session-transfer";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { SessionTransferService } from "../session-transfer-service.js";
import { bearerToken } from "./bearer-token.js";

function exportId(request: FastifyRequest): string {
	return (request.params as { exportId: string }).exportId;
}

export function registerInternalSessionTransferExportRoutes(
	app: FastifyInstance,
	service: SessionTransferService,
): void {
	app.addContentTypeParser(SESSION_TRANSFER_CONTENT_TYPE, (_request, payload, done) => {
		done(null, payload);
	});

	app.get("/internal/session-transfer-exports/:exportId/spec", async (request, reply) => {
		const credential = bearerToken(request);
		const spec = credential
			? service.helperSpec({ exportId: exportId(request), credential })
			: null;
		return spec ? reply.send(spec) : reply.code(404).send({ error: "Export not found" });
	});

	app.post("/internal/session-transfer-exports/:exportId/preflight", async (request, reply) => {
		const credential = bearerToken(request);
		if (
			!credential ||
			!(await service.reportHelperPreflight({
				exportId: exportId(request),
				credential,
				report: request.body,
			}))
		) {
			return reply.code(404).send({ error: "Export not found" });
		}
		return reply.code(204).send();
	});

	app.put("/internal/session-transfer-exports/:exportId/stream", async (request, reply) => {
		const credential = bearerToken(request);
		const stream = request.body;
		if (
			!credential ||
			!stream ||
			typeof (stream as Readable).pipe !== "function" ||
			!service.acceptHelperStream({
				exportId: exportId(request),
				credential,
				stream: stream as Readable,
			})
		) {
			return reply.code(404).send({ error: "Export not found" });
		}
		try {
			await finished(stream as Readable);
			return reply.code(204).send();
		} catch {
			return reply.code(409).send({ error: "Export stream was interrupted" });
		}
	});
}
