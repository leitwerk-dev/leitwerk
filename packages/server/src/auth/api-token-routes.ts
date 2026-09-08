import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApiTokenValidationError } from "./api-token-policy.js";
import type { AuthService } from "./auth-service.js";
import { generateOpaqueToken } from "./auth-tokens.js";
import { authenticateBrowserRequest } from "./fastify-auth.js";

export function registerApiTokenRoutes(app: FastifyInstance, auth: AuthService): void {
	const ownerForRequest = (request: FastifyRequest) => {
		if (!request.actor) throw new Error("Browser authentication context is missing");
		return auth.apiTokens.ownerForActor(request.actor);
	};
	const csrfKey = generateOpaqueToken();
	const anonymousCookie = `${auth.config.sessionCookieName}_token_csrf`;
	const csrfFor = (credential: string) =>
		createHmac("sha256", csrfKey).update(credential).digest("base64url");
	const credentialFor = (request: FastifyRequest) =>
		request.cookies?.[auth.config.enabled ? auth.config.sessionCookieName : anonymousCookie];
	app.register(async (management) => {
		management.addHook("onRequest", async (request, reply) => {
			reply.header("Cache-Control", "no-store");
			if (request.method !== "GET")
				request.tokenAudit = {
					operation:
						request.method === "POST"
							? "token_issuance"
							: request.routeOptions.url?.endsWith(":id")
								? "token_revocation"
								: "token_revoke_all",
				};
			const actor = authenticateBrowserRequest(auth, request);
			if (!actor) return reply.code(401).send({ error: "Browser access required" });
			const owner = auth.apiTokens.ownerForActor(actor);
			if (request.tokenAudit) Object.assign(request.tokenAudit, { actor, ownerKind: owner.kind });
			if (request.method === "GET") return;
			const supplied = request.headers["x-csrf-token"];
			const credential = credentialFor(request);
			const expected = credential ? csrfFor(credential) : "";
			if (
				request.headers.origin !== auth.config.appBaseOrigin ||
				!expected ||
				typeof supplied !== "string" ||
				Buffer.byteLength(supplied) !== Buffer.byteLength(expected) ||
				!timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
			) {
				return reply
					.code(403)
					.send({ error: "Invalid Origin or CSRF context; reload the token page" });
			}
		});
		management.get("/api/auth/tokens", async (request, reply) => {
			let credential = credentialFor(request);
			if (!credential) {
				credential = generateOpaqueToken();
				reply.setCookie(anonymousCookie, credential, {
					httpOnly: true,
					secure: auth.config.secureCookies,
					sameSite: "lax",
					path: "/",
				});
			}
			const owner = ownerForRequest(request);
			return {
				tokens: auth.apiTokens.list(owner),
				policy: auth.apiTokens.policy,
				csrfToken: csrfFor(credential),
			};
		});
		management.post("/api/auth/tokens", async (request, reply) => {
			if (!auth.apiTokens.policy.enabled)
				return reply.code(403).send({ error: "API token issuance is disabled" });
			const body = request.body;
			if (
				!body ||
				typeof body !== "object" ||
				Array.isArray(body) ||
				Object.keys(body).some((key) => key !== "name" && key !== "expiresAt")
			)
				return reply.code(400).send({ error: "Expected name and optional expiresAt" });
			try {
				const input = body as { name?: unknown; expiresAt?: unknown };
				const result = auth.apiTokens.create(ownerForRequest(request), input.name, input.expiresAt);
				request.tokenAudit = {
					...request.tokenAudit,
					operation: "token_issuance",
					tokenId: result.token.id,
				};
				return reply.code(201).send(result);
			} catch (error) {
				if (!(error instanceof ApiTokenValidationError)) throw error;
				return reply.code(400).send({ error: error.message });
			}
		});
		management.delete<{ Params: { id: string } }>(
			"/api/auth/tokens/:id",
			async (request, reply) => {
				if (!auth.apiTokens.revoke(ownerForRequest(request), request.params.id))
					return reply.code(404).send({ error: "Token not found" });
				request.tokenAudit = {
					...request.tokenAudit,
					operation: "token_revocation",
					tokenId: request.params.id,
				};
				return { ok: true };
			},
		);
		management.delete("/api/auth/tokens", async (request) => {
			const count = auth.apiTokens.revokeAll(ownerForRequest(request));
			request.tokenAudit = { ...request.tokenAudit, operation: "token_revoke_all", count };
			return { ok: true, count };
		});
	});
}
