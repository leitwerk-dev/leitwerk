import type { FastifyInstance } from "fastify";
import { hasAuthorization } from "./fastify-auth.js";

export function registerApiTokenAudit(app: FastifyInstance): void {
	app.addHook("onResponse", async (request, reply) => {
		if (!request.tokenAudit && !hasAuthorization(request)) return;
		const params = request.params as Record<string, unknown> | undefined;
		request.log.info(
			{
				event: "api_token_audit",
				timestamp: new Date().toISOString(),
				requestId: request.id,
				...request.tokenAudit,
				operation: request.tokenAudit?.operation ?? "bearer_request",
				method: request.method,
				route: request.routeOptions.url,
				instanceId: params?.instanceId,
				actionId: params?.actionId,
				statusCode: reply.statusCode,
				outcome: reply.statusCode < 400 ? "accepted" : "rejected",
			},
			"API token operation completed",
		);
	});
}
