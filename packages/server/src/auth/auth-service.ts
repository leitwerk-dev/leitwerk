import type { Actor } from "@leitwerk-dev/domain";
import type { LeitwerkConfig } from "../config/config-types.js";
import type { AuthLoginFlowRecord, RepositoryBundle } from "../db/repositories.js";
import { type AuthClient, createAuthClient } from "./auth-client.js";
import {
	isActorAllowedByConfig,
	type ResolvedAuthConfig,
	type ResolvedAuthProvider,
	resolveAuthConfig,
} from "./auth-config.js";
import { generateOpaqueToken, hashOpaqueToken, isoFromNow } from "./auth-tokens.js";
import { createOpenIdClient, type OidcClient } from "./oidc-client.js";

export interface CreatedLoginFlow {
	cookieValue: string;
	redirectUrl: string;
	expiresAt: string;
}

export interface CompletedLogin {
	sessionCookieValue: string;
	actor: Actor;
	expiresAt: string;
}

export interface AuthSweepResult {
	sessions: number;
	loginFlows: number;
}

export interface AuthService {
	readonly config: ResolvedAuthConfig;
	startLogin(): Promise<CreatedLoginFlow>;
	completeLogin(input: { loginCookieValue: string; callbackUrl: URL }): Promise<CompletedLogin>;
	resolveSession(cookieValue: string | undefined): Actor | null;
	logout(cookieValue: string | undefined): void;
	sweepExpiredAuthState(): AuthSweepResult;
	startExpiredAuthStateSweep(intervalMs?: number): () => void;
}

function pickDisplayName(claims: Record<string, unknown>, identity: string): string | undefined {
	for (const key of ["name", "preferred_username", "email"] as const) {
		const value = claims[key];
		if (typeof value === "string" && value.trim() !== "") {
			return value;
		}
	}
	return identity;
}

export function actorFromOidcClaims(input: {
	provider: ResolvedAuthProvider;
	claims: Record<string, unknown>;
}): Actor | null {
	const rawIdentity = input.claims[input.provider.identity_claim];
	const identity = typeof rawIdentity === "string" ? rawIdentity.trim() : "";
	if (identity === "") {
		return null;
	}
	return {
		id: `${input.provider.id}:${identity}`,
		kind: "user",
		provider: input.provider.id,
		displayName: pickDisplayName(input.claims, identity),
	};
}

const DEFAULT_AUTH_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

function consumeValidFlow(
	repos: Pick<RepositoryBundle, "authLoginFlows">,
	cookieValue: string,
): AuthLoginFlowRecord | null {
	const idHash = hashOpaqueToken(cookieValue);
	const flow = repos.authLoginFlows.getValid(idHash);
	if (flow) {
		repos.authLoginFlows.delete(idHash);
	}
	return flow;
}

export function createAuthService(input: {
	config: LeitwerkConfig;
	repos: Pick<RepositoryBundle, "authSessions" | "authLoginFlows">;
	oidcClient?: OidcClient;
	authClient?: AuthClient;
}): AuthService {
	const auth = resolveAuthConfig(input.config);
	const authClient =
		input.authClient ??
		createAuthClient({
			oidc: input.oidcClient ?? createOpenIdClient(),
		});
	const sweepExpiredAuthState = (): AuthSweepResult => ({
		sessions: input.repos.authSessions.deleteExpired(),
		loginFlows: input.repos.authLoginFlows.deleteExpired(),
	});
	sweepExpiredAuthState();

	return {
		config: auth,
		async startLogin() {
			sweepExpiredAuthState();
			if (!auth.enabled || auth.providers.length === 0) {
				throw new Error("Authentication is not enabled");
			}
			const provider = auth.providers[0];
			const login = await authClient.createAuthorizationRequest(provider);
			const cookieValue = generateOpaqueToken();
			const expiresAt = isoFromNow(auth.loginFlowTtlMs);
			input.repos.authLoginFlows.create({
				idHash: hashOpaqueToken(cookieValue),
				providerId: provider.id,
				state: login.state,
				pkceVerifier: login.pkceVerifier,
				expiresAt,
			});
			return { cookieValue, redirectUrl: login.redirectUrl, expiresAt };
		},

		async completeLogin({ loginCookieValue, callbackUrl }) {
			sweepExpiredAuthState();
			if (!auth.enabled) {
				throw new Error("Authentication is not enabled");
			}
			const flow = consumeValidFlow(input.repos, loginCookieValue);
			if (!flow) {
				throw new Error("Login flow expired or was not found");
			}
			const provider = auth.providers.find((p) => p.id === flow.providerId) ?? null;
			if (!provider) {
				throw new Error("Login provider is no longer configured");
			}
			if (callbackUrl.searchParams.get("state") !== flow.state) {
				throw new Error("Invalid authentication state");
			}
			const exchanged = await authClient.exchangeCallback({
				provider,
				callbackUrl,
				state: flow.state,
				pkceVerifier: flow.pkceVerifier,
			});
			const actor = actorFromOidcClaims({ provider, claims: exchanged.claims });
			if (!actor) {
				throw new Error(`Authentication identity claim ${provider.identity_claim} was not present`);
			}
			if (!isActorAllowedByConfig(actor, auth)) {
				throw new Error("Authenticated user is not allowlisted");
			}
			const sessionCookieValue = generateOpaqueToken();
			const expiresAt = isoFromNow(auth.sessionTtlMs);
			input.repos.authSessions.create({
				idHash: hashOpaqueToken(sessionCookieValue),
				actor,
				expiresAt,
			});
			return { sessionCookieValue, actor, expiresAt };
		},

		resolveSession(cookieValue) {
			if (!auth.enabled || !cookieValue) {
				return null;
			}
			const idHash = hashOpaqueToken(cookieValue);
			const session = input.repos.authSessions.getValid(idHash);
			if (!session) {
				return null;
			}
			if (!isActorAllowedByConfig(session.actor, auth)) {
				input.repos.authSessions.delete(idHash);
				return null;
			}
			return session.actor;
		},

		logout(cookieValue) {
			if (cookieValue) {
				input.repos.authSessions.delete(hashOpaqueToken(cookieValue));
			}
		},

		sweepExpiredAuthState,

		startExpiredAuthStateSweep(intervalMs = DEFAULT_AUTH_SWEEP_INTERVAL_MS) {
			const timer = setInterval(sweepExpiredAuthState, intervalMs);
			timer.unref?.();
			return () => clearInterval(timer);
		},
	};
}
