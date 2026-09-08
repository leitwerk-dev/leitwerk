import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { expect, it } from "vitest";
import { createInMemoryDatabase } from "../db/database.js";
import { createAllRepos } from "../db/repositories.js";
import { registerApiTokenAudit } from "./api-token-audit.js";
import { createAuthService } from "./auth-service.js";
import { testAuthConfig } from "./auth-test-helpers.js";
import { hashOpaqueToken } from "./auth-tokens.js";
import { requireApiActor } from "./fastify-auth.js";
import { registerAuthRoutes } from "./routes.js";

it("audits final issuance, bearer, and revocation outcomes without secrets or untrusted token IDs", async () => {
	const lines: string[] = [];
	const app = Fastify({
		logger: {
			stream: {
				write: (line: string) => {
					lines.push(line);
				},
			},
		},
	});
	await app.register(cookie);
	const auth = createAuthService({
		config: testAuthConfig({ auth: { enabled: false } }),
		repos: createAllRepos(createInMemoryDatabase()),
	});
	registerApiTokenAudit(app);
	registerAuthRoutes(app, auth);
	app.post(
		"/api/processes/:instanceId/actions/:actionId",
		{ preHandler: async (req, reply) => requireApiActor(auth, req, reply) },
		(_req, reply) => reply.code(409).send({ error: "Existing lifecycle gate" }),
	);
	try {
		const get = await app.inject({ url: "/api/auth/tokens" });
		const headers = {
			cookie: get.cookies.map((c) => `${c.name}=${c.value}`).join("; "),
			origin: auth.config.appBaseOrigin,
			"x-csrf-token": get.json().csrfToken,
		};
		const created = await app.inject({
			method: "POST",
			url: "/api/auth/tokens",
			headers,
			payload: { name: "audit" },
		});
		const { secret, token } = created.json();
		expect(created.statusCode).toBe(201);
		const bearer = { authorization: `Bearer ${secret}` };
		expect((await app.inject({ url: "/api/auth/me", headers: bearer })).statusCode).toBe(200);
		expect(
			(
				await app.inject({
					method: "POST",
					url: "/api/processes/process-id/actions/action-id",
					headers: bearer,
				})
			).statusCode,
		).toBe(409);
		await app.inject({ method: "DELETE", url: `/api/auth/tokens/${token.id}`, headers });
		expect((await app.inject({ url: "/api/auth/me", headers: bearer })).statusCode).toBe(401);
		await app.inject({ url: "/api/auth/me", headers: { authorization: "Bearer unknown-secret" } });
		await app.inject({ method: "DELETE", url: "/api/auth/tokens", headers });
		const audit = lines
			.map((line) => JSON.parse(line))
			.filter((line) => line.event === "api_token_audit");
		expect(audit).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					operation: "token_issuance",
					tokenId: token.id,
					statusCode: 201,
					outcome: "accepted",
					ownerKind: "anonymous",
				}),
				expect.objectContaining({
					operation: "bearer_request",
					tokenId: token.id,
					statusCode: 409,
					instanceId: "process-id",
					actionId: "action-id",
					outcome: "rejected",
				}),
				expect.objectContaining({
					operation: "token_revocation",
					tokenId: token.id,
					outcome: "accepted",
				}),
				expect.objectContaining({
					operation: "bearer_request",
					tokenId: token.id,
					statusCode: 401,
				}),
				expect.objectContaining({ operation: "token_revoke_all", outcome: "accepted" }),
			]),
		);
		const unknown = audit.find(
			(line) => line.operation === "bearer_request" && line.statusCode === 401 && !line.tokenId,
		);
		expect(unknown).toBeTruthy();
		expect(audit.every((line) => line.requestId && line.timestamp)).toBe(true);
		const log = lines.join("");
		expect(log).not.toContain(secret);
		expect(log).not.toContain(hashOpaqueToken(secret));
		expect(log).not.toContain("unknown-secret");
	} finally {
		await app.close();
	}
});
