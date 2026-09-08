import type { AuthMeResponseBody } from "@leitwerk-dev/protocol/http-contracts";
import type { FastifyInstance } from "fastify";
import { registerApiTokenRoutes } from "./api-token-routes.js";
import type { AuthService } from "./auth-service.js";
import { authenticateRequest } from "./fastify-auth.js";

function cookieMaxAgeSeconds(expiresAt: string): number {
	return Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
}

function cookieOptions(input: { secure: boolean; maxAge: number }) {
	return {
		httpOnly: true,
		secure: input.secure,
		sameSite: "lax" as const,
		path: "/",
		maxAge: input.maxAge,
	};
}

export function registerAuthRoutes(app: FastifyInstance, auth: AuthService): void {
	registerApiTokenRoutes(app, auth);
	app.get("/api/auth/me", async (request, reply) => {
		const actor = authenticateRequest(auth, request);
		if (!actor) {
			return reply
				.code(401)
				.send({ authEnabled: auth.config.enabled, actor: null } satisfies AuthMeResponseBody);
		}
		return reply.send({ authEnabled: auth.config.enabled, actor } satisfies AuthMeResponseBody);
	});

	app.get("/auth/login", async (_request, reply) => {
		if (!auth.config.enabled) {
			return reply.redirect("/");
		}
		try {
			const login = await auth.startLogin();
			reply.setCookie(
				auth.config.loginFlowCookieName,
				login.cookieValue,
				cookieOptions({
					secure: auth.config.secureCookies,
					maxAge: cookieMaxAgeSeconds(login.expiresAt),
				}),
			);
			return reply.redirect(login.redirectUrl);
		} catch (error) {
			app.log.warn({ err: error }, "Failed to start OIDC login");
			return reply.code(503).send({ error: "Login is temporarily unavailable" });
		}
	});

	app.get("/auth/callback", async (request, reply) => {
		if (!auth.config.enabled) {
			return reply.redirect("/");
		}
		const loginCookieValue = request.cookies?.[auth.config.loginFlowCookieName];
		if (!loginCookieValue) {
			return reply.code(400).send({ error: "Missing login cookie" });
		}
		try {
			const login = await auth.completeLogin({
				loginCookieValue,
				callbackUrl: new URL(request.url, auth.config.providers[0].redirect_uri),
			});
			reply.clearCookie(auth.config.loginFlowCookieName, { path: "/" });
			reply.setCookie(
				auth.config.sessionCookieName,
				login.sessionCookieValue,
				cookieOptions({
					secure: auth.config.secureCookies,
					maxAge: cookieMaxAgeSeconds(login.expiresAt),
				}),
			);
			return reply.redirect("/");
		} catch (error) {
			app.log.warn({ err: error }, "Failed to complete OIDC login");
			reply.clearCookie(auth.config.loginFlowCookieName, { path: "/" });
			return reply.code(403).send({ error: "Login failed" });
		}
	});

	app.post("/auth/logout", async (request, reply) => {
		auth.logout(request.cookies?.[auth.config.sessionCookieName]);
		reply.clearCookie(auth.config.sessionCookieName, { path: "/" });
		return reply.send({ ok: true });
	});
}
