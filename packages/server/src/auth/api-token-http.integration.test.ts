import cookie from "@fastify/cookie";
import { type Actor, ADMIN_ACTOR } from "@leitwerk-dev/domain";
import Fastify, { type FastifyInstance, type InjectOptions } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createInMemoryDatabase } from "../db/database.js";
import { createAllRepos } from "../db/repositories.js";
import { createAuthService } from "./auth-service.js";
import { testAuthConfig } from "./auth-test-helpers.js";
import { hashOpaqueToken } from "./auth-tokens.js";
import { authenticateBrowserRequest, requireApiActor } from "./fastify-auth.js";
import { registerAuthRoutes } from "./routes.js";

const apps: FastifyInstance[] = [];
afterEach(async () => {
	await Promise.all(apps.splice(0).map((app) => app.close()));
});
async function harness(enabled: boolean) {
	const app = Fastify();
	apps.push(app);
	await app.register(cookie);
	const config = testAuthConfig({ auth: { enabled, allowlist: ["alice", "bob"] } });
	const repos = createAllRepos(createInMemoryDatabase());
	const auth = createAuthService({ config, repos });
	registerAuthRoutes(app, auth);
	app.get(
		"/api/read",
		{ preHandler: async (req, reply) => requireApiActor(auth, req, reply) },
		(req) => ({ actor: req.actor }),
	);
	app.get("/browser", (req, reply) => {
		const actor = authenticateBrowserRequest(auth, req);
		return actor ?? reply.code(401).send({ error: "denied" });
	});
	async function expectStatus(status: number, options: InjectOptions) {
		const response = await app.inject(options);
		expect(response.statusCode, response.body).toBe(status);
		return response;
	}
	const session = (id: string) => {
		const actor: Actor = { id: `identity:${id}`, provider: "identity", kind: "user" };
		repos.authSessions.create({
			idHash: hashOpaqueToken(id),
			actor,
			expiresAt: new Date(Date.now() + 60000).toISOString(),
		});
		return `orch_test_session=${id}`;
	};
	const initialCookie = enabled ? session("alice") : undefined;
	async function browser(cookieValue = initialCookie) {
		const response = await expectStatus(200, {
			url: "/api/auth/tokens",
			headers: cookieValue ? { cookie: cookieValue } : {},
		});
		const csrfCookie = response.cookies.find((c) => c.name.endsWith("_token_csrf"));
		const browserCookie =
			cookieValue ?? (csrfCookie ? `${csrfCookie.name}=${csrfCookie.value}` : "");
		return {
			cookie: browserCookie,
			"x-csrf-token": response.json().csrfToken as string,
			origin: config.server.base_url,
		};
	}
	return { auth, browser, session, expectStatus };
}
describe.each([true, false])("API token HTTP with auth enabled=%s", (enabled) => {
	it("creates a secret once, authenticates HTTP, denies browser and management access, then revokes", async () => {
		const { browser, expectStatus } = await harness(enabled);
		const headers = await browser();
		const creation = await expectStatus(201, {
			method: "POST",
			url: "/api/auth/tokens",
			headers,
			payload: { name: "canary", expiresAt: new Date(Date.now() + 1800000).toISOString() },
		});
		expect(creation.headers["cache-control"]).toBe("no-store");
		const { secret, token } = creation.json();
		const bearer = { authorization: `Bearer ${secret}` };
		const read = await expectStatus(200, { url: "/api/read", headers: bearer });
		expect(read.json().actor).toMatchObject(enabled ? { id: "identity:alice" } : ADMIN_ACTOR);
		await expectStatus(200, { url: "/api/auth/me", headers: bearer });
		await expectStatus(401, { url: "/browser", headers: bearer });
		for (const method of ["GET", "POST", "DELETE"] as const) {
			const denied = await expectStatus(401, {
				method,
				url: "/api/auth/tokens",
				headers: { ...headers, ...bearer },
			});
			expect(denied.headers["cache-control"]).toBe("no-store");
		}
		await expectStatus(401, {
			method: "DELETE",
			url: `/api/auth/tokens/${token.id}`,
			headers: bearer,
		});
		const listed = await expectStatus(200, { url: "/api/auth/tokens", headers });
		expect(listed.body).not.toContain(secret);
		expect(listed.body).not.toContain("secretHash");
		await expectStatus(200, { method: "DELETE", url: `/api/auth/tokens/${token.id}`, headers });
		await expectStatus(401, { url: "/api/read", headers: bearer });
	});
	it("rejects malformed, duplicate, unknown and ambiguous credentials without fallback", async () => {
		const { auth, expectStatus } = await harness(enabled);
		for (const authorization of [
			"Basic abc",
			"Bearer",
			"Bearer unknown",
			"Bearer a, Bearer b",
			["Bearer a", "Bearer b"],
			"Bearer a Bearer b",
			"",
		]) {
			for (const url of ["/api/auth/me", "/api/read"])
				await expectStatus(401, { url, headers: { authorization } });
		}
		const actor: Actor = enabled
			? { id: "identity:alice", provider: "identity", kind: "user" }
			: ADMIN_ACTOR;
		const { secret } = auth.apiTokens.create(auth.apiTokens.ownerForActor(actor), "test", null);
		await expectStatus(401, {
			url: "/api/read",
			headers: { authorization: `Bearer ${secret}`, cookie: "orch_test_session=invalid" },
		});
		await expectStatus(enabled ? 401 : 200, { url: `/api/read?token=${secret}` });
	});
	it("requires exact Origin and browser-bound CSRF, and conceals foreign ownership", async () => {
		const { browser, session, expectStatus } = await harness(enabled);
		const first = await browser();
		const second = await browser(enabled ? session("bob") : undefined);
		for (const headers of [
			{ ...first, origin: undefined },
			{ ...first, origin: `${first.origin}/` },
			{ ...first, "x-csrf-token": undefined },
			{ ...first, "x-csrf-token": second["x-csrf-token"] },
			{ ...first, "x-csrf-token": "é".repeat(43) },
		]) {
			const response = await expectStatus(403, {
				method: "POST",
				url: "/api/auth/tokens",
				headers: Object.fromEntries(
					Object.entries(headers).filter(([, value]) => value !== undefined),
				),
				payload: { name: "test" },
			});
			expect(response.headers["cache-control"]).toBe("no-store");
		}
		const created = await expectStatus(201, {
			method: "POST",
			url: "/api/auth/tokens",
			headers: first,
			payload: { name: "first" },
		});
		const list = await expectStatus(200, { url: "/api/auth/tokens", headers: second });
		expect(list.json().tokens).toHaveLength(enabled ? 0 : 1);
		await expectStatus(enabled ? 404 : 200, {
			method: "DELETE",
			url: `/api/auth/tokens/${created.json().token.id}`,
			headers: second,
		});
		await expectStatus(400, {
			method: "POST",
			url: "/api/auth/tokens",
			headers: first,
			payload: { name: "spoof", owner: "bob" },
		});
		await expectStatus(200, { method: "DELETE", url: "/api/auth/tokens", headers: first });
	});
});
