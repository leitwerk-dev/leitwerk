import type { FastifyInstance } from "fastify";
import { getProcessDisplayName } from "../process-operator-attention.js";
import { getProcessOrReply, type RouteDeps } from "./process-route-helpers.js";

export function registerProcessSessionRoutes(app: FastifyInstance, deps: RouteDeps) {
	app.get<{ Params: { instanceId: string } }>(
		"/api/processes/:instanceId/session",
		async (req, reply) => {
			const process = getProcessOrReply(deps, req.params.instanceId, reply);
			if (!process) return;

			const content = await deps.sessionReader.readRawContent(process.id);
			if (content === null) {
				return reply.code(404).send({ error: "Session file not found" });
			}

			const processDisplayName = getProcessDisplayName(deps, process.processId);
			const titlePart = (processDisplayName || process.processId)
				.replace(/[^a-zA-Z0-9_-]/g, "_")
				.slice(0, 50);
			const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
			const filename = `${process.id}-${titlePart}-${timestamp}.jsonl`;

			return reply
				.header("Content-Type", "application/x-ndjson")
				.header("Content-Disposition", `attachment; filename="${filename}"`)
				.send(content);
		},
	);
}
