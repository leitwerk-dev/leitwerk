import { type Actor, ADMIN_ACTOR } from "@leitwerk-dev/domain";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AuthService } from "./auth-service.js";

declare module "fastify" {
	interface FastifyRequest {
		actor?: Actor;
	}
}

export function actorForRequest(request: FastifyRequest): Actor {
	return request.actor ?? ADMIN_ACTOR;
}

export function authenticateRequest(auth: AuthService, request: FastifyRequest): Actor | null {
	if (!auth.config.enabled) {
		return ADMIN_ACTOR;
	}
	const cookieValue = request.cookies?.[auth.config.sessionCookieName];
	return auth.resolveSession(cookieValue);
}

export function requireApiActor(
	auth: AuthService,
	request: FastifyRequest,
	reply: FastifyReply,
): void {
	const actor = authenticateRequest(auth, request);
	if (actor) {
		request.actor = actor;
		return;
	}
	reply.code(401).send({ error: "Authentication required" });
}
