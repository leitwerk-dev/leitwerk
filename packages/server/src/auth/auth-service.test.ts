import { describe, expect, it } from "vitest";
import { getDefaultConfig } from "../config/config-loader.js";
import { createInMemoryDatabase } from "../db/database.js";
import { createAllRepos } from "../db/repositories.js";
import { resolveAuthConfig } from "./auth-config.js";
import { actorFromOidcClaims, createAuthService } from "./auth-service.js";
import { testAuthConfig } from "./auth-test-helpers.js";
import { hashOpaqueToken } from "./auth-tokens.js";
import type { OidcClient } from "./oidc-client.js";

describe("auth config resolution", () => {
	it("keeps auth disabled when no provider is configured", () => {
		const resolved = resolveAuthConfig(getDefaultConfig());
		expect(resolved.enabled).toBe(false);
		expect(resolved.sessionCookieName).toBe("leitwerk_session");
	});

	it("keeps auth disabled unless explicitly enabled even when a provider is configured", () => {
		const config = testAuthConfig();
		if (config.auth) delete config.auth.enabled;

		const resolved = resolveAuthConfig(config);

		expect(resolved.enabled).toBe(false);
		expect(resolved.providers).toHaveLength(1);
	});

	it("derives provider defaults from server base_url", () => {
		const config = testAuthConfig({ baseUrl: "https://leitwerk.example.test/base" });
		const resolved = resolveAuthConfig(config);
		expect(resolved.enabled).toBe(true);
		expect(resolved.providers[0]).toMatchObject({
			redirect_uri: "https://leitwerk.example.test/auth/callback",
			identity_claim: "preferred_username",
			scopes: ["openid", "profile", "email"],
		});
		expect(resolved.secureCookies).toBe(true);
	});
});

describe("OIDC actor derivation", () => {
	it("uses the configured identity claim and namespaces the actor by provider", () => {
		const provider = resolveAuthConfig(testAuthConfig()).providers[0];
		const actor = actorFromOidcClaims({
			provider,
			claims: { preferred_username: "alice", name: "Alice A." },
		});
		expect(actor).toEqual({
			id: "forgejo:alice",
			kind: "user",
			provider: "forgejo",
			displayName: "Alice A.",
		});
	});

	it("returns null when the identity claim is missing", () => {
		const provider = resolveAuthConfig(testAuthConfig()).providers[0];
		expect(actorFromOidcClaims({ provider, claims: { sub: "123" } })).toBeNull();
	});
});

describe("auth service login flow", () => {
	it("creates a session for an allowlisted OIDC identity and resolves it from the opaque cookie", async () => {
		let observedState = "";
		const oidcClient: OidcClient = {
			async createAuthorizationRequest(provider) {
				observedState = "state-1";
				return {
					provider,
					state: observedState,
					pkceVerifier: "verifier-1",
					redirectUrl: "https://forgejo.example.test/oauth/authorize",
				};
			},
			async exchangeCallback() {
				return { claims: { preferred_username: "alice", name: "Alice" } };
			},
		};
		const repos = createAllRepos(createInMemoryDatabase());
		const service = createAuthService({ config: testAuthConfig(), repos, oidcClient });

		const flow = await service.startLogin();
		const completed = await service.completeLogin({
			loginCookieValue: flow.cookieValue,
			callbackUrl: new URL(
				`https://leitwerk.example.test/auth/callback?code=c&state=${observedState}`,
			),
		});

		expect(completed.actor.id).toBe("forgejo:alice");
		expect(service.resolveSession(completed.sessionCookieValue)).toMatchObject({
			id: "forgejo:alice",
			displayName: "Alice",
		});
		expect(repos.authSessions.getValid(completed.sessionCookieValue)).toBeNull();
	});

	it("rejects sessions for providers that are no longer configured", () => {
		const repos = createAllRepos(createInMemoryDatabase());
		const service = createAuthService({ config: testAuthConfig(), repos });
		const rawSession = "provider-mismatch-session";
		repos.authSessions.create({
			idHash: hashOpaqueToken(rawSession),
			actor: { id: "gitlab:alice", kind: "user", provider: "gitlab" },
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
		});

		expect(service.resolveSession(rawSession)).toBeNull();
		expect(repos.authSessions.getValid(hashOpaqueToken(rawSession))).toBeNull();
	});

	it("sweeps expired session and login-flow rows", () => {
		const repos = createAllRepos(createInMemoryDatabase());
		const service = createAuthService({ config: testAuthConfig(), repos });
		repos.authSessions.create({
			idHash: hashOpaqueToken("expired-session"),
			actor: { id: "forgejo:alice", kind: "user", provider: "forgejo" },
			expiresAt: "2000-01-01T00:00:00.000Z",
		});
		repos.authLoginFlows.create({
			idHash: hashOpaqueToken("expired-flow"),
			providerId: "forgejo",
			state: "state",
			pkceVerifier: "verifier",
			expiresAt: "2000-01-01T00:00:00.000Z",
		});

		expect(service.sweepExpiredAuthState()).toEqual({ sessions: 1, loginFlows: 1 });
		expect(repos.authSessions.getValid(hashOpaqueToken("expired-session"))).toBeNull();
		expect(repos.authLoginFlows.getValid(hashOpaqueToken("expired-flow"))).toBeNull();
	});

	it("rejects non-allowlisted identities", async () => {
		const oidcClient: OidcClient = {
			async createAuthorizationRequest(provider) {
				return {
					provider,
					state: "s",
					pkceVerifier: "v",
					redirectUrl: "https://provider/authorize",
				};
			},
			async exchangeCallback() {
				return { claims: { preferred_username: "mallory" } };
			},
		};
		const service = createAuthService({
			config: testAuthConfig(),
			repos: createAllRepos(createInMemoryDatabase()),
			oidcClient,
		});
		const flow = await service.startLogin();
		await expect(
			service.completeLogin({
				loginCookieValue: flow.cookieValue,
				callbackUrl: new URL("https://leitwerk.example.test/auth/callback?code=c&state=s"),
			}),
		).rejects.toThrow();
	});
});
