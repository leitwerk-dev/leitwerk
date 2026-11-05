import { getDefaultConfig } from "../config/config-loader.js";
import type {
	AuthConfig,
	AuthOidcProviderConfig,
	AuthSessionConfig,
} from "../config/config-types.js";
import type { OidcEvidence } from "./oidc-evidence.js";

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

export function setCookieValues(headers: string | string[] | undefined): string[] {
	return Array.isArray(headers) ? headers : headers ? [headers] : [];
}
