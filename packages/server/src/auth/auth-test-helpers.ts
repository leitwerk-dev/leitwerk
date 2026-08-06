import { getDefaultConfig } from "../config/config-loader.js";
import type {
	AuthConfig,
	AuthOidcProviderConfig,
	AuthSessionConfig,
} from "../config/config-types.js";

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
				id: "forgejo",
				kind: "oidc",
				issuer: "https://forgejo.example.test",
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

export function setCookieValues(headers: string | string[] | undefined): string[] {
	return Array.isArray(headers) ? headers : headers ? [headers] : [];
}
