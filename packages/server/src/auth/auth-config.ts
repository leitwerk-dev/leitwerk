import type { Actor } from "@leitwerk-dev/domain";
import { parseDurationMs } from "@leitwerk-dev/watcher-utils";
import type {
	AuthGithubProviderConfig,
	AuthOidcProviderConfig,
	LeitwerkConfig,
} from "../config/config-types.js";

export interface ResolvedOidcProvider extends AuthOidcProviderConfig {
	redirect_uri: string;
	scopes: string[];
	identity_claim: string;
}

export interface ResolvedGithubProvider extends AuthGithubProviderConfig {
	redirect_uri: string;
	scopes: ["read:org"];
	identity_claim: "login";
}

export type ResolvedAuthProvider = ResolvedOidcProvider | ResolvedGithubProvider;

export interface ResolvedAuthConfig {
	enabled: boolean;
	sessionCookieName: string;
	loginFlowCookieName: string;
	sessionTtlMs: number;
	loginFlowTtlMs: number;
	secureCookies: boolean;
	appBaseOrigin: string;
	providers: ResolvedAuthProvider[];
	allowlist: Set<string>;
}

const DEFAULT_SESSION_COOKIE_NAME = "leitwerk_session";
const DEFAULT_SESSION_TTL = "7d";
const DEFAULT_LOGIN_FLOW_TTL_MS = 10 * 60 * 1000;

export function resolveAuthConfig(config: LeitwerkConfig): ResolvedAuthConfig {
	const auth = config.auth;
	const serverBaseUrl = new URL(config.server.base_url);
	const providers: ResolvedAuthProvider[] = (auth?.providers ?? []).map((provider) =>
		provider.kind === "oidc"
			? {
					...provider,
					redirect_uri:
						provider.redirect_uri ?? new URL("/auth/callback", serverBaseUrl).toString(),
					scopes: provider.scopes ?? ["openid", "profile", "email"],
					identity_claim: provider.identity_claim ?? "preferred_username",
				}
			: {
					...provider,
					redirect_uri:
						provider.redirect_uri ?? new URL("/auth/callback", serverBaseUrl).toString(),
					scopes: ["read:org"],
					identity_claim: "login",
				},
	);
	const sessionCookieName = auth?.session?.cookie_name ?? DEFAULT_SESSION_COOKIE_NAME;
	return {
		enabled: auth?.enabled === true && providers.length > 0,
		sessionCookieName,
		loginFlowCookieName: `${sessionCookieName}_login`,
		sessionTtlMs: parseDurationMs(
			auth?.session?.ttl ?? DEFAULT_SESSION_TTL,
			7 * 24 * 60 * 60 * 1000,
			{
				allowHours: true,
			},
		),
		loginFlowTtlMs: DEFAULT_LOGIN_FLOW_TTL_MS,
		secureCookies: serverBaseUrl.protocol === "https:",
		appBaseOrigin: serverBaseUrl.origin,
		providers,
		allowlist: new Set(auth?.allowlist ?? []),
	};
}

export function isActorAllowedByConfig(actor: Actor, auth: ResolvedAuthConfig): boolean {
	if (!auth.enabled) {
		return true;
	}
	if (actor.kind !== "user" || actor.provider === null) {
		return false;
	}
	if (!auth.providers.some((provider) => provider.id === actor.provider)) {
		return false;
	}
	const prefix = `${actor.provider}:`;
	if (!actor.id.startsWith(prefix)) return false;
	const provider = auth.providers.find((candidate) => candidate.id === actor.provider);
	return provider?.kind === "oauth2" || auth.allowlist.has(actor.id.slice(prefix.length));
}
