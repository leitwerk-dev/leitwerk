import { describe, expect, it, vi } from "vitest";
import type { ResolvedGithubProvider } from "./auth-config.js";
import { createGithubOauthClient } from "./github-oauth-client.js";

const provider: ResolvedGithubProvider = {
	id: "github",
	kind: "oauth2",
	client_id: "github-client",
	client_secret: "github-secret",
	organization: "leitwerk-dev",
	redirect_uri: "https://leitwerk.example.test/auth/callback",
	scopes: ["read:org"],
	identity_claim: "login",
};

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("GitHub OAuth client", () => {
	it("builds the authorization request for organization access", async () => {
		const client = createGithubOauthClient(vi.fn<typeof fetch>());
		const request = await client.createAuthorizationRequest(provider);
		const redirect = new URL(request.redirectUrl);

		expect(`${redirect.origin}${redirect.pathname}`).toBe(
			"https://github.com/login/oauth/authorize",
		);
		expect(redirect.searchParams.get("client_id")).toBe("github-client");
		expect(redirect.searchParams.get("redirect_uri")).toBe(provider.redirect_uri);
		expect(redirect.searchParams.get("scope")).toBe("read:org");
		expect(redirect.searchParams.get("state")).toBe(request.state);
		expect(request.pkceVerifier).not.toBe("");
	});

	it("returns normalized user claims for an active organization member", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(jsonResponse({ access_token: "access-token" }))
			.mockResolvedValueOnce(jsonResponse({ login: "Alice", name: "Alice A." }))
			.mockResolvedValueOnce(jsonResponse({ state: "active", role: "member" }));
		const client = createGithubOauthClient(fetchMock);

		const result = await client.exchangeCallback({
			provider,
			callbackUrl: new URL(`${provider.redirect_uri}?code=code-1&state=state-1`),
			state: "state-1",
			pkceVerifier: "unused",
		});

		expect(result.claims).toMatchObject({ login: "alice", name: "Alice A." });
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(fetchMock.mock.calls[2]?.[0]).toBe(
			"https://api.github.com/user/memberships/orgs/leitwerk-dev",
		);
	});

	it.each([
		["missing membership", jsonResponse({}, 404)],
		["pending membership", jsonResponse({ state: "pending" })],
	])("rejects %s", async (_name, membershipResponse) => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(jsonResponse({ access_token: "access-token" }))
			.mockResolvedValueOnce(jsonResponse({ login: "alice" }))
			.mockResolvedValueOnce(membershipResponse);
		const client = createGithubOauthClient(fetchMock);

		await expect(
			client.exchangeCallback({
				provider,
				callbackUrl: new URL(`${provider.redirect_uri}?code=code-1`),
				state: "state-1",
				pkceVerifier: "unused",
			}),
		).rejects.toThrow("membership is not active");
	});
});
