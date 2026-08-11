import type { ResolvedAuthProvider } from "./auth-config.js";
import { createGithubOauthClient, type GithubOauthClient } from "./github-oauth-client.js";
import { createOpenIdClient, type OidcClient } from "./oidc-client.js";

export interface AuthAuthorizationRequest {
	provider: ResolvedAuthProvider;
	state: string;
	pkceVerifier: string;
	redirectUrl: string;
}

export interface AuthClient {
	createAuthorizationRequest(provider: ResolvedAuthProvider): Promise<AuthAuthorizationRequest>;
	exchangeCallback(input: {
		provider: ResolvedAuthProvider;
		callbackUrl: URL;
		state: string;
		pkceVerifier: string;
	}): Promise<{ claims: Record<string, unknown> }>;
}

export function createAuthClient(input?: {
	oidc?: OidcClient;
	github?: GithubOauthClient;
}): AuthClient {
	const oidc = input?.oidc ?? createOpenIdClient();
	const github = input?.github ?? createGithubOauthClient();
	return {
		createAuthorizationRequest(provider) {
			return provider.kind === "oidc"
				? oidc.createAuthorizationRequest(provider)
				: github.createAuthorizationRequest(provider);
		},
		exchangeCallback(request) {
			return request.provider.kind === "oidc"
				? oidc.exchangeCallback({ ...request, provider: request.provider })
				: github.exchangeCallback({ ...request, provider: request.provider });
		},
	};
}
