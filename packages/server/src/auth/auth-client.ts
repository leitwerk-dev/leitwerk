import type { ResolvedAuthProvider } from "./auth-config.js";
import { createGithubOauthClient, type GithubOauthClient } from "./github-oauth-client.js";
import { createOpenIdClient, type OidcClient } from "./oidc-client.js";
import { actorFromClaims, interpretOidcLogin } from "./oidc-evidence.js";

/** @internal */
export interface AuthAuthorizationRequest {
	state: string;
	pkceVerifier: string;
	redirectUrl: string;
}

/** @internal */
export interface AuthCallbackRequest<P = ResolvedAuthProvider> {
	provider: P;
	callbackUrl: URL;
	state: string;
	pkceVerifier: string;
}

export function createAuthClient(input?: { oidc?: OidcClient; github?: GithubOauthClient }) {
	const oidc = input?.oidc ?? createOpenIdClient();
	const github = input?.github ?? createGithubOauthClient();
	return {
		createAuthorizationRequest(provider: ResolvedAuthProvider) {
			return provider.kind === "oidc"
				? oidc.createAuthorizationRequest(provider)
				: github.createAuthorizationRequest(provider);
		},
		async exchangeCallback(request: AuthCallbackRequest) {
			if (request.provider.kind === "oidc")
				return interpretOidcLogin(
					request.provider,
					await oidc.exchangeCallback({ ...request, provider: request.provider }),
				);
			const { claims } = await github.exchangeCallback({ ...request, provider: request.provider });
			return { actor: actorFromClaims(request.provider, claims), oidcEvidence: null };
		},
	};
}
