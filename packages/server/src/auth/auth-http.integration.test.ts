import cookie from "@fastify/cookie";
import { type Actor, ADMIN_ACTOR } from "@leitwerk-dev/domain";
import { createTestAppContext } from "@leitwerk-dev/test-support/integration";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createAllRepos, type RepositoryBundle } from "../db/repositories.js";
import { type AppContext, getDefaultConfig } from "../index.js";
import { createOwnedInMemoryDatabase as createInMemoryDatabase } from "../test-helpers/owned-test-deps.js";
import { createAuthService } from "./auth-service.js";
import {
	createTestOidcClient as createOidcClient,
	setCookieValues,
	testAuthConfig,
	testOidcEvidence,
} from "./auth-test-helpers.js";
import { hashOpaqueToken } from "./auth-tokens.js";
import type { OidcClient } from "./oidc-client.js";
import { registerAuthRoutes } from "./routes.js";

const PROVIDER_REDIRECT_URL = "https://identity.example.test/oauth/authorize";

describe("auth HTTP guard", () => {
	let ctx: AppContext | null = null;
	let authRouteApp: FastifyInstance | null = null;

	async function createAuthRouteHarness(options: {
		config?: ReturnType<typeof testAuthConfig>;
		oidcClient: OidcClient;
	}): Promise<{ app: FastifyInstance; repos: RepositoryBundle }> {
		const repos = createAllRepos(createInMemoryDatabase());
		authRouteApp = Fastify({ logger: false });
		await authRouteApp.register(cookie);
		registerAuthRoutes(
			authRouteApp,
			createAuthService({
				config: options.config ?? testAuthConfig(),
				repos,
				oidcClient: options.oidcClient,
			}),
		);
		return { app: authRouteApp, repos };
	}

	afterEach(async () => {
		await authRouteApp?.close();
		authRouteApp = null;
		await ctx?.close();
		ctx = null;
	});

	it("serves claims only to the current OIDC session, never bearer tokens or bootstrap", async () => {
		const { app, repos } = await createAuthRouteHarness({ oidcClient: createOidcClient({}) });
		const evidence = testOidcEvidence("alice", {
			name: "<script>not HTML</script>",
			groups: ["operators"],
		});
		evidence.userInfoClaims = {
			sub: evidence.subject,
			email: "alice@example.com",
			email_verified: true,
		};
		const actor: Actor = { id: "identity:alice", kind: "user", provider: "identity" };
		repos.authSessions.create({
			idHash: hashOpaqueToken("information-session"),
			actor,
			oidcEvidence: evidence,
			expiresAt: new Date(Date.now() + 60000).toISOString(),
		});
		const headers = { cookie: "orch_test_session=information-session" };
		const information = await app.inject({ url: "/api/auth/user-information", headers });
		expect(information.statusCode).toBe(200);
		expect(information.headers["cache-control"]).toBe("no-store");
		expect(information.json()).toMatchObject({
			idTokenClaims: evidence.idTokenClaims,
			userInfoClaims: evidence.userInfoClaims,
		});
		const bootstrap = await app.inject({ url: "/api/auth/me", headers });
		expect(bootstrap.json().actor).toEqual(actor);
		expect(bootstrap.body).not.toContain("operators");
		expect(bootstrap.body).not.toContain("idTokenClaims");
		const auth = createAuthService({ config: testAuthConfig(), repos });
		const { secret } = auth.apiTokens.create(
			auth.apiTokens.ownerForActor(actor, evidence),
			"test",
			null,
		);
		for (const deniedHeaders of [
			{},
			{ authorization: `Bearer ${secret}` },
			{ ...headers, authorization: `Bearer ${secret}` },
			{ cookie: "orch_test_session=expired" },
		]) {
			const denied = await app.inject({
				url: "/api/auth/user-information?user=bob",
				headers: deniedHeaders,
			});
			expect(denied.statusCode).toBe(401);
			expect(denied.headers["cache-control"]).toBe("no-store");
			expect(denied.body).not.toContain("idTokenClaims");
		}
	});

	it("returns the admin actor when auth is disabled", async () => {
		ctx = await createTestAppContext({ logger: false, config: getDefaultConfig() });

		const response = await ctx.app.inject({ method: "GET", url: "/api/auth/me" });

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({ authEnabled: false, actor: ADMIN_ACTOR });
	});

	it("keeps API requests unauthenticated when provider wiring is present but not enabled", async () => {
		const config = testAuthConfig();
		if (config.auth) delete config.auth.enabled;
		ctx = await createTestAppContext({ logger: false, config });

		const me = await ctx.app.inject({ method: "GET", url: "/api/auth/me" });
		const processes = await ctx.app.inject({ method: "GET", url: "/api/processes" });

		expect(me.statusCode).toBe(200);
		expect(me.json()).toMatchObject({ authEnabled: false, actor: ADMIN_ACTOR });
		expect(processes.statusCode).toBe(200);
	});

	it("rejects API requests without a valid session when auth is enabled", async () => {
		ctx = await createTestAppContext({ logger: false, config: testAuthConfig() });

		const me = await ctx.app.inject({ method: "GET", url: "/api/auth/me" });
		const processes = await ctx.app.inject({ method: "GET", url: "/api/processes" });
		const resultImage = await ctx.app.inject({
			method: "GET",
			url: "/api/processes/prc_missing/turn-records/trn_missing/result-images/img_missing.png",
		});

		expect(me.statusCode).toBe(401);
		expect(processes.statusCode).toBe(401);
		expect(resultImage.statusCode).toBe(401);
		for (const [method, url] of [
			["GET", "/api/settings/scopes"],
			["GET", "/api/settings/definitions"],
			["GET", "/api/settings/preview"],
			["PUT", "/api/settings/overrides"],
			["POST", "/api/settings/scopes/refresh"],
		] as const) {
			expect((await ctx.app.inject({ method, url })).statusCode).toBe(401);
		}
	});

	it("sets a short-lived secure login-flow cookie on login", async () => {
		const { app } = await createAuthRouteHarness({
			config: testAuthConfig({ baseUrl: "https://leitwerk.example.test" }),
			oidcClient: createOidcClient({ state: "state-1" }),
		});

		const response = await app.inject({ method: "GET", url: "/auth/login" });

		expect(response.statusCode).toBe(302);
		expect(response.headers.location).toBe(PROVIDER_REDIRECT_URL);
		const loginCookie = setCookieValues(response.headers["set-cookie"]).find((value) =>
			value.startsWith("orch_test_session_login="),
		);
		expect(loginCookie).toEqual(expect.stringContaining("HttpOnly"));
		expect(loginCookie).toEqual(expect.stringContaining("Secure"));
		expect(loginCookie).toEqual(expect.stringContaining("SameSite=Lax"));
		expect(loginCookie).toEqual(expect.stringContaining("Path=/"));
		expect(loginCookie).toEqual(expect.stringMatching(/Max-Age=\d+/));
	});

	it("returns a generic error when login initialization fails", async () => {
		const { app } = await createAuthRouteHarness({
			oidcClient: createOidcClient({ startError: new Error("private-provider-discovery-detail") }),
		});

		const response = await app.inject({ method: "GET", url: "/auth/login" });

		expect(response.statusCode).toBe(503);
		expect(response.body).not.toContain("private-provider-discovery-detail");
		expect(response.json()).toMatchObject({ error: expect.any(String) });
	});

	it("exchanges the callback for a session cookie and clears the login cookie", async () => {
		const { app } = await createAuthRouteHarness({
			config: testAuthConfig({ baseUrl: "https://leitwerk.example.test" }),
			oidcClient: createOidcClient({
				state: "state-2",
				claims: { sub: "subject-alice", preferred_username: "alice", name: "Alice" },
			}),
		});
		const loginResponse = await app.inject({ method: "GET", url: "/auth/login" });
		const loginCookie = setCookieValues(loginResponse.headers["set-cookie"]).find((value) =>
			value.startsWith("orch_test_session_login="),
		);
		expect(loginCookie).toBeDefined();

		const callbackResponse = await app.inject({
			method: "GET",
			url: "/auth/callback?code=code-1&state=state-2",
			headers: { cookie: loginCookie?.split(";", 1)[0] ?? "" },
		});

		expect(callbackResponse.statusCode).toBe(302);
		expect(callbackResponse.headers.location).toBe("/");
		const cookies = setCookieValues(callbackResponse.headers["set-cookie"]);
		expect(cookies.some((value) => value.startsWith("orch_test_session_login=;"))).toBe(true);
		const sessionCookie = cookies.find((value) => value.startsWith("orch_test_session="));
		expect(sessionCookie).toEqual(expect.stringContaining("HttpOnly"));
		expect(sessionCookie).toEqual(expect.stringContaining("Secure"));
		expect(sessionCookie).toEqual(expect.stringContaining("SameSite=Lax"));
		expect(sessionCookie).toEqual(expect.stringContaining("Path=/"));
	});

	it("clears the login cookie and returns a generic error when callback completion fails", async () => {
		const { app } = await createAuthRouteHarness({
			oidcClient: createOidcClient({
				state: "state-3",
				callbackError: new Error("private-provider-callback-detail"),
			}),
		});
		const loginResponse = await app.inject({ method: "GET", url: "/auth/login" });
		const loginCookie = setCookieValues(loginResponse.headers["set-cookie"]).find((value) =>
			value.startsWith("orch_test_session_login="),
		);

		const callbackResponse = await app.inject({
			method: "GET",
			url: "/auth/callback?code=code-1&state=state-3",
			headers: { cookie: loginCookie?.split(";", 1)[0] ?? "" },
		});

		expect(callbackResponse.statusCode).toBe(403);
		expect(callbackResponse.body).not.toContain("private-provider-callback-detail");
		expect(callbackResponse.json()).toMatchObject({ error: expect.any(String) });
		expect(
			setCookieValues(callbackResponse.headers["set-cookie"]).some((value) =>
				value.startsWith("orch_test_session_login=;"),
			),
		).toBe(true);
	});

	it("attaches the session actor to authenticated API requests", async () => {
		const config = testAuthConfig();
		ctx = await createTestAppContext({ logger: false, config });
		const rawSession = "raw-session-token";
		const actor: Actor = {
			id: "identity:alice",
			kind: "user",
			provider: "identity",
			displayName: "Alice",
		};
		createAllRepos(ctx.db).authSessions.create({
			oidcEvidence: testOidcEvidence(),
			idHash: hashOpaqueToken(rawSession),
			actor,
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
		});

		const response = await ctx.app.inject({
			method: "GET",
			url: "/api/auth/me",
			headers: { cookie: `orch_test_session=${rawSession}` },
		});
		const processes = await ctx.app.inject({
			method: "GET",
			url: "/api/processes",
			headers: { cookie: `orch_test_session=${rawSession}` },
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({ authEnabled: true, actor });
		expect(processes.statusCode).toBe(200);
	});

	it("persists the authenticated actor on mutating route events", async () => {
		const config = testAuthConfig();
		ctx = await createTestAppContext({ logger: false, config });
		const repos = createAllRepos(ctx.db);
		const rawSession = "mutating-route-session";
		const actor: Actor = {
			id: "identity:alice",
			kind: "user",
			provider: "identity",
			displayName: "Alice",
		};
		repos.authSessions.create({
			oidcEvidence: testOidcEvidence(),
			idHash: hashOpaqueToken(rawSession),
			actor,
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
		});
		const process = repos.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: null,
			lifecycleStatus: "discovered",
		});

		const response = await ctx.app.inject({
			method: "POST",
			url: `/api/processes/${process.id}/abort`,
			headers: { cookie: `orch_test_session=${rawSession}` },
		});

		expect(response.statusCode).toBe(200);
		const abortEvent = repos.events
			.listByInstance(process.id, 10)
			.find((event) => event.eventType === "process_aborted");
		expect(abortEvent?.data.actor).toEqual(actor);
	});
});
