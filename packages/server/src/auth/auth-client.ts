import type { Actor } from "@leitwerk-dev/domain";
import type { ResolvedAuthProvider } from "./auth-config.js";
import { createGithubOauthClient, type GithubOauthClient } from "./github-oauth-client.js";
import { createOpenIdClient, type OidcClient } from "./oidc-client.js";
import { interpretLogin, type OidcEvidence } from "./oidc-evidence.js";

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
	}): Promise<{ actor: Actor; oidcEvidence: OidcEvidence | null }>;
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
		async exchangeCallback(request) {
			return request.provider.kind === "oidc"
				? interpretLogin(
						request.provider,
						await oidc.exchangeCallback({ ...request, provider: request.provider }),
					)
				: interpretLogin(
						request.provider,
						await github.exchangeCallback({ ...request, provider: request.provider }),
					);
		},
	};
}
