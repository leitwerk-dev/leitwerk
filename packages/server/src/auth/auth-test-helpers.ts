import { randomUUID } from "node:crypto";
import type { Actor } from "@leitwerk-dev/domain";
import { getDefaultConfig } from "../config/config-loader.js";
import type {
	AuthConfig,
	AuthOidcProviderConfig,
	AuthSessionConfig,
} from "../config/config-types.js";
import { createAllRepos, type RepositoryBundle } from "../db/repositories.js";
import { createOwnedInMemoryDatabase } from "../test-helpers/owned-test-deps.js";
import { type AuthService, createAuthService } from "./auth-service.js";
import { hashOpaqueToken } from "./auth-tokens.js";
import type { OidcClient, OidcTokensAndClaims } from "./oidc-client.js";
import type { OidcEvidence } from "./oidc-evidence.js";

/** @internal */
export function createTestOidcClient(options: {
	state?: string;
	claims?: Record<string, unknown>;
	result?: OidcTokensAndClaims;
	startError?: Error;
	callbackError?: Error;
}): OidcClient {
	return {
		async createAuthorizationRequest(provider) {
			if (options.startError) throw options.startError;
			const state = options.state ?? "state";
			return {
				provider,
				state,
				pkceVerifier: `verifier-${state}`,
				redirectUrl: "https://identity.example.test/oauth/authorize",
			};
		},
		async exchangeCallback() {
			if (options.callbackError) throw options.callbackError;
			if (options.result) return options.result;
			if (!options.claims) throw new Error("not used");
			return { claims: options.claims, idTokenClaims: options.claims, userInfoClaims: null };
		},
	};
}

/** @internal */
export function createTestOidcLogin(
	config: ReturnType<typeof testAuthConfig>,
	options: Parameters<typeof createTestOidcClient>[0],
) {
	const repos = createAllRepos(createOwnedInMemoryDatabase());
	const auth = createAuthService({ config, repos, oidcClient: createTestOidcClient(options) });
	return {
		auth,
		repos,
		async completeLogin() {
			const flow = await auth.startLogin();
			const callbackUrl = new URL("/auth/callback", config.server.base_url);
			callbackUrl.search = new URLSearchParams({
				code: "c",
				state: options.state ?? "state",
			}).toString();
			return auth.completeLogin({ loginCookieValue: flow.cookieValue, callbackUrl });
		},
	};
}

export function testAuthConfig(overrides?: {
	cookieName?: string;
	baseUrl?: string;
	auth?: Partial<AuthConfig>;
	provider?: Partial<AuthOidcProviderConfig>;
	session?: Partial<AuthSessionConfig>;
}) {
	const config = getDefaultConfig();
	config.server.base_url = overrides?.baseUrl ?? "https://leitwerk.example.test";
	config.auth = {
		enabled: true,
		session: {
			cookie_name: overrides?.cookieName ?? "orch_test_session",
			ttl: "1h",
			...overrides?.session,
		},
		providers: [
			{
				id: "identity",
				kind: "oidc",
				issuer: "https://identity.example.test",
				client_id: "client",
				client_secret: "secret",
				...overrides?.provider,
			},
		],
		allowlist: ["alice"],
		...overrides?.auth,
	};
	return config;
}

export function testOidcEvidence(
	identity = "alice",
	claims: Record<string, unknown> = {},
): OidcEvidence {
	return {
		providerId: "identity",
		issuer: "https://identity.example.test",
		identityClaim: "preferred_username",
		subject: `subject-${identity}`,
		loginAt: "2026-01-01T00:00:00.000Z",
		idTokenClaims: { sub: `subject-${identity}`, preferred_username: identity, ...claims },
		userInfoClaims: null,
		facts: { identity, email: null, emailVerified: false, groups: [] },
	};
}

/** @internal */
export function createTestSession(
	repos: Pick<RepositoryBundle, "authSessions">,
	actor: Actor,
	oidcEvidence: OidcEvidence | null = null,
) {
	const cookie = randomUUID();
	repos.authSessions.create({
		idHash: hashOpaqueToken(cookie),
		actor,
		oidcEvidence,
		expiresAt: new Date(Date.now() + 60000).toISOString(),
	});
	return cookie;
}

/** @internal */
export function createTestSessionOwner(
	auth: AuthService,
	...session: Parameters<typeof createTestSession>
) {
	const owner = auth.tokenOwnerForSession(createTestSession(...session));
	if (!owner) throw new Error("Expected session token owner");
	return owner;
}

export function setCookieValues(headers: string | string[] | undefined): string[] {
	return Array.isArray(headers) ? headers : headers ? [headers] : [];
}
