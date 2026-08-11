import { randomBytes } from "node:crypto";
import type { ResolvedGithubProvider } from "./auth-config.js";

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_API_URL = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";

export interface GithubAuthorizationRequest {
	provider: ResolvedGithubProvider;
	state: string;
	pkceVerifier: string;
	redirectUrl: string;
}

export interface GithubOauthClient {
	createAuthorizationRequest(provider: ResolvedGithubProvider): Promise<GithubAuthorizationRequest>;
	exchangeCallback(input: {
		provider: ResolvedGithubProvider;
		callbackUrl: URL;
		state: string;
		pkceVerifier: string;
	}): Promise<{ claims: Record<string, unknown> }>;
}

function opaqueValue(): string {
	return randomBytes(32).toString("base64url");
}

function githubHeaders(accessToken?: string): HeadersInit {
	return {
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": GITHUB_API_VERSION,
		"User-Agent": "leitwerk-server",
		...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
	};
}

async function jsonObject(
	response: Response,
	errorMessage: string,
): Promise<Record<string, unknown>> {
	if (!response.ok) throw new Error(errorMessage);
	const value: unknown = await response.json();
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(errorMessage);
	}
	return value as Record<string, unknown>;
}

export function createGithubOauthClient(fetchImpl: typeof fetch = fetch): GithubOauthClient {
	return {
		async createAuthorizationRequest(provider) {
			const state = opaqueValue();
			const redirectUrl = new URL(GITHUB_AUTHORIZE_URL);
			redirectUrl.searchParams.set("client_id", provider.client_id);
			redirectUrl.searchParams.set("redirect_uri", provider.redirect_uri);
			redirectUrl.searchParams.set("scope", provider.scopes.join(" "));
			redirectUrl.searchParams.set("state", state);
			return {
				provider,
				state,
				// The persisted login-flow schema requires a verifier. GitHub OAuth Apps
				// authenticate this confidential client with its secret instead of PKCE.
				pkceVerifier: opaqueValue(),
				redirectUrl: redirectUrl.toString(),
			};
		},

		async exchangeCallback({ provider, callbackUrl }) {
			const code = callbackUrl.searchParams.get("code");
			if (!code) throw new Error("GitHub OAuth callback did not include a code");

			const tokenResponse = await fetchImpl(GITHUB_TOKEN_URL, {
				method: "POST",
				headers: { ...githubHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					client_id: provider.client_id,
					client_secret: provider.client_secret,
					code,
					redirect_uri: provider.redirect_uri,
				}).toString(),
			});
			const token = await jsonObject(tokenResponse, "GitHub OAuth token exchange failed");
			const accessToken = typeof token.access_token === "string" ? token.access_token : "";
			if (!accessToken) throw new Error("GitHub OAuth token exchange failed");

			const userResponse = await fetchImpl(`${GITHUB_API_URL}/user`, {
				headers: githubHeaders(accessToken),
			});
			const user = await jsonObject(userResponse, "GitHub user lookup failed");
			const login = typeof user.login === "string" ? user.login.trim().toLowerCase() : "";
			if (!login) throw new Error("GitHub user lookup failed");

			const organization = encodeURIComponent(provider.organization);
			const membershipResponse = await fetchImpl(
				`${GITHUB_API_URL}/user/memberships/orgs/${organization}`,
				{ headers: githubHeaders(accessToken) },
			);
			const membership = await jsonObject(
				membershipResponse,
				"GitHub organization membership is not active",
			);
			if (membership.state !== "active") {
				throw new Error("GitHub organization membership is not active");
			}

			return { claims: { ...user, login } };
		},
	};
}
