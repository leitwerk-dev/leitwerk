import { SESSION_TRANSFER_CONTENT_TYPE } from "@leitwerk-dev/session-transfer";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isHttpsOrLoopbackHttpUrl } from "../config/url-policy.js";
import type { SessionTransferService } from "../session-transfer-service.js";
import { bearerToken } from "./bearer-token.js";

function isSafeTransferBaseUrl(value: string): boolean {
	if (!isHttpsOrLoopbackHttpUrl(value)) return false;
	const url = new URL(value);
	return !url.username && !url.password && !url.search && !url.hash;
}

function params(request: FastifyRequest): {
	instanceId: string;
	grantId: string;
	attemptId?: string;
} {
	return request.params as { instanceId: string; grantId: string; attemptId?: string };
}

function attemptAuth(request: FastifyRequest) {
	const token = bearerToken(request);
	const route = params(request);
	return token && route.attemptId ? { ...route, attemptId: route.attemptId, token } : null;
}

export function registerSessionTransferRoutes(
	app: FastifyInstance,
	service: SessionTransferService,
	publicBaseUrl: string,
): void {
	app.post("/api/processes/:instanceId/session-transfers", async (request, reply) => {
		const { instanceId } = request.params as { instanceId: string };
		if (!isSafeTransferBaseUrl(publicBaseUrl)) {
			return reply.code(503).send({
				error: "Local session transfer requires an HTTPS deployment URL",
				code: "transfer_requires_https",
			});
		}
		const result = await service.createGrant(instanceId);
		if (result.kind === "not_found")
			return reply.code(404).send({ error: "Process or primary session not found" });
		if (result.kind === "deletion_pending")
			return reply
				.code(409)
				.send({ error: "Process deletion is pending", code: "deletion_pending" });
		const grantPath = `/api/session-transfers/${encodeURIComponent(instanceId)}/${encodeURIComponent(result.grantId)}`;
		return reply.code(201).send({
			transferUrl: `${new URL(grantPath, publicBaseUrl).toString()}#token=${encodeURIComponent(result.rawToken)}`,
			expiresAt: result.expiresAt,
		});
	});

	app.post("/api/session-transfers/:instanceId/:grantId/attempts", async (request, reply) => {
		const token = bearerToken(request);
		if (!token) return reply.code(404).send({ error: "Transfer not found" });
		const route = params(request);
		const result = service.startAttempt({
			instanceId: route.instanceId,
			grantId: route.grantId,
			token,
		});
		if (result.kind === "not_found") return reply.code(404).send({ error: "Transfer not found" });
		if (result.kind === "busy")
			return reply.code(409).send({
				error: "Another transfer is active for this process",
				code: "transfer_busy",
				retryable: true,
			});
		return reply.code(202).send({ attempt: result.attempt });
	});

	const sendHeartbeat = async (request: FastifyRequest, reply: FastifyReply) => {
		const auth = attemptAuth(request);
		const status = auth ? service.heartbeat(auth) : null;
		return status
			? reply.send({ attempt: status })
			: reply.code(404).send({ error: "Transfer not found" });
	};
	app.get("/api/session-transfers/:instanceId/:grantId/attempts/:attemptId", sendHeartbeat);

	app.get(
		"/api/session-transfers/:instanceId/:grantId/attempts/:attemptId/stream",
		async (request, reply) => {
			const auth = attemptAuth(request);
			const attempt = auth ? service.heartbeat(auth) : null;
			if (!auth || !attempt) return reply.code(404).send({ error: "Transfer not found" });
			if (attempt.phase !== "ready_to_stream")
				return reply.code(409).send({
					error: "Transfer stream is not ready",
					code: "stream_not_ready",
					phase: attempt.phase,
				});
			try {
				const stream = service.openStream(auth);
				return reply
					.header("Content-Type", SESSION_TRANSFER_CONTENT_TYPE)
					.header("Cache-Control", "no-store")
					.header("Referrer-Policy", "no-referrer")
					.send(stream);
			} catch {
				return reply
					.code(409)
					.send({ error: "Transfer stream is unavailable", code: "stream_unavailable" });
			}
		},
	);

	app.delete(
		"/api/session-transfers/:instanceId/:grantId/attempts/:attemptId",
		async (request, reply) => {
			const auth = attemptAuth(request);
			const status = auth ? service.cancel(auth) : null;
			return status
				? reply.send({ attempt: status })
				: reply.code(404).send({ error: "Transfer not found" });
		},
	);

	app.post(
		"/api/session-transfers/:instanceId/:grantId/attempts/:attemptId/acknowledge",
		async (request, reply) => {
			const auth = attemptAuth(request);
			if (!auth) return reply.code(404).send({ error: "Transfer not found" });
			const status = service.acknowledge(auth);
			return status
				? reply.send({ attempt: status })
				: reply
						.code(409)
						.send({ error: "Transfer cannot be acknowledged", code: "acknowledgement_not_ready" });
		},
	);

	app.post(
		"/api/processes/:instanceId/session-transfers/:attemptId/cancel",
		async (request, reply) => {
			const route = request.params as { instanceId: string; attemptId: string };
			const status = service.cancelForWeb(route.instanceId, route.attemptId);
			return status
				? reply.send({ attempt: status })
				: reply.code(404).send({ error: "Transfer not found" });
		},
	);
}
