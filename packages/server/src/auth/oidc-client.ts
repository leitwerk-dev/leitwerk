import {
	allowInsecureRequests,
	authorizationCodeGrant,
	buildAuthorizationUrl,
	ClientSecretPost,
	type Configuration,
	calculatePKCECodeChallenge,
	discovery,
	fetchUserInfo,
	randomPKCECodeVerifier,
	randomState,
	skipSubjectCheck,
} from "openid-client";
import { isLoopbackHttpUrl } from "../config/url-policy.js";
import type { ResolvedOidcProvider } from "./auth-config.js";

export interface OidcAuthorizationRequest {
	provider: ResolvedOidcProvider;
	state: string;
	pkceVerifier: string;
	redirectUrl: string;
}

export interface OidcTokensAndClaims {
	claims: Record<string, unknown>;
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
			if (tokens.access_token) {
				const expectedSubject = typeof idClaims?.sub === "string" ? idClaims.sub : skipSubjectCheck;
				try {
					const userInfo = (await fetchUserInfo(
						config,
						tokens.access_token,
						expectedSubject,
					)) as Record<string, unknown>;
					return { claims: { ...(idClaims ?? {}), ...userInfo } };
				} catch {
					// best-effort: fall through to idClaims
				}
			}
			if (idClaims) return { claims: idClaims };
			throw new Error("OIDC token response did not include an access token or id_token claims");
		},
	};
}
