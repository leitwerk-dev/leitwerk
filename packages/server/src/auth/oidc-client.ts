import {
	allowInsecureRequests,
	authorizationCodeGrant,
	buildAuthorizationUrl,
	ClientError,
	ClientSecretPost,
	type Configuration,
	calculatePKCECodeChallenge,
	discovery,
	fetchUserInfo,
	randomPKCECodeVerifier,
	randomState,
} from "openid-client";
import { isLoopbackHttpUrl } from "../config/url-policy.js";
import type { ResolvedOidcProvider } from "./auth-config.js";

export interface OidcAuthorizationRequest {
	provider: ResolvedOidcProvider;
	state: string;
	pkceVerifier: string;
	redirectUrl: string;
}

/** @internal */
export interface OidcTokensAndClaims {
	idTokenClaims: Record<string, unknown>;
	userInfoClaims: Record<string, unknown> | null;
}

export interface OidcClient {
	createAuthorizationRequest(provider: ResolvedOidcProvider): Promise<OidcAuthorizationRequest>;
	exchangeCallback(input: {
		provider: ResolvedOidcProvider;
		callbackUrl: URL;
		state: string;
		pkceVerifier: string;
	}): Promise<OidcTokensAndClaims>;
}

export function createOpenIdClient(): OidcClient {
	const configs = new Map<string, Promise<Configuration>>();

	async function getConfiguration(provider: ResolvedOidcProvider): Promise<Configuration> {
		const key = `${provider.id}:${provider.issuer}:${provider.client_id}`;
		let configPromise = configs.get(key);
		if (!configPromise) {
			configPromise = discovery(
				new URL(provider.issuer),
				provider.client_id,
				{
					redirect_uris: [provider.redirect_uri],
					response_types: ["code"],
				},
				ClientSecretPost(provider.client_secret),
				isLoopbackHttpUrl(provider.issuer) ? { execute: [allowInsecureRequests] } : undefined,
			);
			configs.set(key, configPromise);
		}
		return configPromise;
	}

	return {
		async createAuthorizationRequest(provider) {
			const config = await getConfiguration(provider);
			const state = randomState();
			const pkceVerifier = randomPKCECodeVerifier();
			const codeChallenge = await calculatePKCECodeChallenge(pkceVerifier);
			const redirectUrl = buildAuthorizationUrl(config, {
				redirect_uri: provider.redirect_uri,
				scope: provider.scopes.join(" "),
				state,
				code_challenge: codeChallenge,
				code_challenge_method: "S256",
			}).toString();
			return { provider, state, pkceVerifier, redirectUrl };
		},

		async exchangeCallback(input) {
			const config = await getConfiguration(input.provider);
			const tokens = await authorizationCodeGrant(
				config,
				input.callbackUrl,
				{
					expectedState: input.state,
					pkceCodeVerifier: input.pkceVerifier,
				},
				{ redirect_uri: input.provider.redirect_uri },
			);
			const idClaims = tokens.claims() as Record<string, unknown> | undefined;
			if (!idClaims || typeof idClaims.sub !== "string" || !idClaims.sub.trim()) {
				throw new Error("OIDC ID token requires a valid subject");
			}
			let userInfo: Record<string, unknown> | null = null;
			if (tokens.access_token) {
				// Fetch without suppressing subject mismatch errors as optional network failures.
				try {
					userInfo = (await fetchUserInfo(config, tokens.access_token, idClaims.sub)) as Record<
						string,
						unknown
					>;
				} catch (error) {
					// Only availability failures are optional. Invalid responses fail closed.
					if (
						!(error instanceof TypeError) &&
						!(
							error instanceof ClientError &&
							(error.code === "OAUTH_TIMEOUT" ||
								(error.cause instanceof Response && error.cause.status >= 500))
						)
					)
						throw new Error("OIDC UserInfo validation failed");
				}
				if (userInfo && userInfo.sub !== idClaims.sub)
					throw new Error("OIDC UserInfo subject mismatch");
			}
			return {
				idTokenClaims: idClaims,
				userInfoClaims: userInfo,
			};
		},
	};
}
