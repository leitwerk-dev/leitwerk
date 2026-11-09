import { type Actor, ADMIN_ACTOR } from "@leitwerk-dev/domain";
import type { LeitwerkConfig } from "../config/config-types.js";
import type { ApiTokenOwner, AuthLoginFlowRecord, RepositoryBundle } from "../db/repositories.js";
import { resolveApiTokenPolicy } from "./api-token-policy.js";
import {
	type ApiTokenService,
	createApiTokenService,
	tokenProviderBinding,
} from "./api-token-service.js";
import { createAuthClient } from "./auth-client.js";
import {
	isActorAllowedByConfig,
	type ResolvedAuthConfig,
	resolveAuthConfig,
} from "./auth-config.js";
import { generateOpaqueToken, hashOpaqueToken, isoFromNow } from "./auth-tokens.js";
import type { GithubOauthClient } from "./github-oauth-client.js";
import type { OidcClient } from "./oidc-client.js";
import type { OidcEvidence } from "./oidc-evidence.js";

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
	readonly apiTokens: ApiTokenService;
	startLogin(): Promise<CreatedLoginFlow>;
	completeLogin(input: { loginCookieValue: string; callbackUrl: URL }): Promise<CompletedLogin>;
	resolveSession(cookieValue: string | undefined): Actor | null;
	/** @internal */
	tokenOwnerForSession(cookieValue: string | undefined): ApiTokenOwner | null;
	userInformation(cookieValue: string | undefined): OidcEvidence | null;
	logout(cookieValue: string | undefined): void;
	sweepExpiredAuthState(): AuthSweepResult;
	startExpiredAuthStateSweep(intervalMs?: number): () => void;
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
	repos: Pick<RepositoryBundle, "authSessions" | "authLoginFlows" | "apiTokens">;
	oidcClient?: OidcClient;
	githubClient?: GithubOauthClient;
}): AuthService {
	const auth = resolveAuthConfig(input.config);
	const authClient = createAuthClient({ oidc: input.oidcClient, github: input.githubClient });
	const sweepExpiredAuthState = (): AuthSweepResult => ({
		sessions: input.repos.authSessions.deleteExpired(),
		loginFlows: input.repos.authLoginFlows.deleteExpired(),
	});
	sweepExpiredAuthState();

	function resolveSessionRecord(cookieValue: string | undefined) {
		if (!auth.enabled || !cookieValue) return null;
		const idHash = hashOpaqueToken(cookieValue);
		const session = input.repos.authSessions.getValid(idHash);
		if (!session) return null;
		if (isActorAllowedByConfig(session.actor, auth, session.oidcEvidence)) return session;
		input.repos.authSessions.delete(idHash);
		return null;
	}

	return {
		config: auth,
		apiTokens: createApiTokenService({
			auth,
			policy: resolveApiTokenPolicy(input.config.auth?.api_tokens),
			repo: input.repos.apiTokens,
		}),
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
			const { actor, oidcEvidence } = await authClient.exchangeCallback({
				provider,
				callbackUrl,
				state: flow.state,
				pkceVerifier: flow.pkceVerifier,
			});
			if (!isActorAllowedByConfig(actor, auth, oidcEvidence)) {
				throw new Error("Authenticated user does not satisfy admission policy");
			}
			const sessionCookieValue = generateOpaqueToken();
			const expiresAt = isoFromNow(auth.sessionTtlMs);
			input.repos.authSessions.create({
				idHash: hashOpaqueToken(sessionCookieValue),
				actor,
				oidcEvidence,
				expiresAt,
			});
			return { sessionCookieValue, actor, expiresAt };
		},

		resolveSession(cookieValue) {
			return resolveSessionRecord(cookieValue)?.actor ?? null;
		},

		tokenOwnerForSession(cookieValue) {
			if (!auth.enabled)
				return { kind: "anonymous", id: "anonymous", actor: ADMIN_ACTOR, providerBinding: null };
			const session = resolveSessionRecord(cookieValue);
			if (!session) return null;
			const provider = auth.providers.find((p) => p.id === session.actor.provider);
			if (!provider) return null;
			return {
				kind: "user",
				id: session.actor.id,
				actor: session.actor,
				providerBinding: tokenProviderBinding(provider),
				oidcEvidence: session.oidcEvidence,
			};
		},

		userInformation(cookieValue) {
			return resolveSessionRecord(cookieValue)?.oidcEvidence ?? null;
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
