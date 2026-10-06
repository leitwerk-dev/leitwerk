import { type Actor, ADMIN_ACTOR } from "@leitwerk-dev/domain";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AuthService } from "./auth-service.js";

/** @internal */
export interface TokenAuditContext {
	/** @internal */
	operation: string;
	/** @internal */
	tokenId?: string;
	/** @internal */
	actor?: Actor;
	/** @internal */
	ownerKind?: "user" | "anonymous";
	/** @internal */
	count?: number;
}
declare module "fastify" {
	/** @internal */
	interface FastifyRequest {
		/** @internal */
		actor?: Actor;
		/** @internal */
		tokenAudit?: TokenAuditContext;
	}
}
export function actorForRequest(request: FastifyRequest): Actor {
	return request.actor ?? ADMIN_ACTOR;
}
export function hasAuthorization(request: FastifyRequest): boolean {
	return (
		request.headers.authorization !== undefined ||
		request.raw.rawHeaders.some(
			(value, i) => i % 2 === 0 && value.toLowerCase() === "authorization",
		)
	);
}
function resolved(request: FastifyRequest, actor: Actor): Actor {
	request.actor = actor;
	return actor;
}
export function authenticateBrowserRequest(
	auth: AuthService,
	request: FastifyRequest,
): Actor | null {
	if (hasAuthorization(request)) return null;
	if (!auth.config.enabled) return resolved(request, ADMIN_ACTOR);
	const actor = auth.resolveSession(request.cookies?.[auth.config.sessionCookieName]);
	return actor ? resolved(request, actor) : null;
}
export function authenticateRequest(auth: AuthService, request: FastifyRequest): Actor | null {
	if (!hasAuthorization(request)) return authenticateBrowserRequest(auth, request);
	request.tokenAudit = { operation: "bearer_request" };
	const headerCount = request.raw.rawHeaders.filter(
		(v, i) => i % 2 === 0 && v.toLowerCase() === "authorization",
	).length;
	const header = request.headers.authorization;
	if (
		headerCount > 1 ||
		typeof header !== "string" ||
		Object.hasOwn(request.cookies ?? {}, auth.config.sessionCookieName)
	)
		return null;
	const match = /^Bearer ([A-Za-z0-9_-]+)$/i.exec(header);
	if (!match) return null;
	const result = auth.apiTokens.resolve(match[1]);
	if (result.token) {
		request.tokenAudit = {
			/** @internal */
			operation: "bearer_request",
			/** @internal */
			tokenId: result.token.id,
			/** @internal */
			actor: result.token.owner.actor,
			/** @internal */
			ownerKind: result.token.owner.kind,
		};
	}
	return result.actor && result.token ? resolved(request, result.actor) : null;
}
export function requireApiActor(
	auth: AuthService,
	request: FastifyRequest,
	reply: FastifyReply,
): void {
	if (!authenticateRequest(auth, request))
		reply.code(401).send({ error: "Authentication required" });
}
