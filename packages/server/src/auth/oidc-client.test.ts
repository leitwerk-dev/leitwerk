import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import type { ResolvedOidcProvider } from "./auth-config.js";
import { createOpenIdClient } from "./oidc-client.js";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });

async function startLocalOidcMetadataServer(options?: {
	idClaims?: Record<string, unknown>;
	userInfo?: Record<string, unknown>;
	userInfoStatus?: number;
}): Promise<{
	issuer: string;
	close: () => Promise<void>;
}> {
	let issuer = "";
	const server: Server = createServer((request, response) => {
		if (request.url === "/jwks") {
			response.writeHead(200, { "content-type": "application/json" }).end(
				JSON.stringify({
					keys: [
						{
							...keys.publicKey.export({ format: "jwk" }),
							kid: "test",
							alg: "RS256",
							use: "sig",
						},
					],
				}),
			);
			return;
		}
		if (request.url === "/token" && options) {
			const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test" })).toString(
				"base64url",
			);
			const payload = Buffer.from(
				JSON.stringify({
					iss: issuer,
					aud: "client",
					iat: Math.floor(Date.now() / 1000),
					exp: Math.floor(Date.now() / 1000) + 600,
					...options.idClaims,
				}),
			).toString("base64url");
			const jwt = `${header}.${payload}.${sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), keys.privateKey).toString("base64url")}`;
			response.writeHead(200, { "content-type": "application/json" }).end(
				JSON.stringify({
					access_token: "never-retain-access-token",
					refresh_token: "never-retain-refresh-token",
					token_type: "Bearer",
					id_token: jwt,
				}),
			);
			return;
		}
		if (request.url === "/userinfo" && options) {
			response
				.writeHead(options.userInfoStatus ?? 200, { "content-type": "application/json" })
				.end(JSON.stringify(options.userInfo ?? {}));
			return;
		}
		if (!request.url?.includes("/.well-known/")) {
			response.writeHead(404).end();
			return;
		}
		response.writeHead(200, { "content-type": "application/json" });
		response.end(
			JSON.stringify({
				issuer,
				authorization_endpoint: new URL("authorize", issuer).toString(),
				token_endpoint: new URL("token", issuer).toString(),
				jwks_uri: new URL("jwks", issuer).toString(),
				userinfo_endpoint: new URL("userinfo", issuer).toString(),
				response_types_supported: ["code"],
				subject_types_supported: ["public"],
				id_token_signing_alg_values_supported: ["RS256"],
			}),
		);
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address() as AddressInfo;
	issuer = `http://127.0.0.1:${address.port}/`;

	return {
		issuer,
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			}),
	};
}

function providerWithIssuer(issuer: string): ResolvedOidcProvider {
	return {
		id: "identity",
		kind: "oidc",
		issuer,
		client_id: "client",
		client_secret: "secret",
		redirect_uri: "http://localhost:8080/auth/callback",
		scopes: ["openid", "profile"],
		identity_claim: "preferred_username",
	};
}

describe("OpenID client", () => {
	it("retains distinct validated claim sources, never OAuth credentials", async () => {
		const server = await startLocalOidcMetadataServer({
			idClaims: { sub: "subject", preferred_username: "alice", name: "ID name" },
			userInfo: { sub: "subject", name: "UserInfo name", groups: ["operators"] },
		});
		try {
			const client = createOpenIdClient();
			const provider = providerWithIssuer(server.issuer);
			const login = await client.createAuthorizationRequest(provider);
			const exchanged = await client.exchangeCallback({
				provider,
				callbackUrl: new URL(`${provider.redirect_uri}?code=c&state=${login.state}`),
				state: login.state,
				pkceVerifier: login.pkceVerifier,
			});
			expect(exchanged.idTokenClaims).toMatchObject({ sub: "subject", name: "ID name" });
			expect(exchanged.userInfoClaims).toEqual({
				sub: "subject",
				name: "UserInfo name",
				groups: ["operators"],
			});
			expect(exchanged.claims.name).toBe("UserInfo name");
			expect(JSON.stringify(exchanged)).not.toContain("never-retain");
			expect(exchanged).not.toHaveProperty("id_token");
		} finally {
			await server.close();
		}
	});
	it.each([
		{},
		{ sub: "" },
		{ sub: 123 },
	])("requires valid ID-token subject: %j", async (idClaims) => {
		const server = await startLocalOidcMetadataServer({ idClaims, userInfo: { sub: "subject" } });
		try {
			const client = createOpenIdClient();
			const provider = providerWithIssuer(server.issuer);
			const login = await client.createAuthorizationRequest(provider);
			await expect(
				client.exchangeCallback({
					provider,
					callbackUrl: new URL(`${provider.redirect_uri}?code=c&state=${login.state}`),
					state: login.state,
					pkceVerifier: login.pkceVerifier,
				}),
			).rejects.toThrow();
		} finally {
			await server.close();
		}
	});
	it.each([
		{},
		{ sub: "other" },
		{ sub: 123 },
	])("rejects received UserInfo with invalid/mismatched subject: %j", async (userInfo) => {
		const server = await startLocalOidcMetadataServer({ idClaims: { sub: "subject" }, userInfo });
		try {
			const client = createOpenIdClient();
			const provider = providerWithIssuer(server.issuer);
			const login = await client.createAuthorizationRequest(provider);
			await expect(
				client.exchangeCallback({
					provider,
					callbackUrl: new URL(`${provider.redirect_uri}?code=c&state=${login.state}`),
					state: login.state,
					pkceVerifier: login.pkceVerifier,
				}),
			).rejects.toThrow();
		} finally {
			await server.close();
		}
	});
	it("can fall back to ID-token claims when optional UserInfo is unavailable", async () => {
		const server = await startLocalOidcMetadataServer({
			idClaims: { sub: "subject", preferred_username: "alice" },
			userInfoStatus: 503,
		});
		try {
			const client = createOpenIdClient();
			const provider = providerWithIssuer(server.issuer);
			const login = await client.createAuthorizationRequest(provider);
			const exchanged = await client.exchangeCallback({
				provider,
				callbackUrl: new URL(`${provider.redirect_uri}?code=c&state=${login.state}`),
				state: login.state,
				pkceVerifier: login.pkceVerifier,
			});
			expect(exchanged.userInfoClaims).toBeNull();
			expect(exchanged.claims).toMatchObject({ sub: "subject", preferred_username: "alice" });
		} finally {
			await server.close();
		}
	});
	it("allows loopback HTTP issuer discovery for local auth development", async () => {
		const oidcServer = await startLocalOidcMetadataServer();
		try {
			const client = createOpenIdClient();

			const request = await client.createAuthorizationRequest(
				providerWithIssuer(oidcServer.issuer),
			);

			const redirectUrl = new URL(request.redirectUrl);
			expect(`${redirectUrl.origin}${redirectUrl.pathname}`).toBe(
				new URL("authorize", oidcServer.issuer).toString().replace(/\/$/, ""),
			);
			expect(redirectUrl.searchParams.get("client_id")).toBe("client");
			expect(redirectUrl.searchParams.get("redirect_uri")).toBe(
				"http://localhost:8080/auth/callback",
			);
			expect(redirectUrl.searchParams.get("scope")).toBe("openid profile");
			expect(request.state).not.toBe("");
			expect(redirectUrl.searchParams.get("state")).toBe(request.state);
			expect(request.pkceVerifier).not.toBe("");
			expect(redirectUrl.searchParams.get("code_challenge_method")).toBe("S256");
			expect(redirectUrl.searchParams.get("code_challenge")).toBe(
				createHash("sha256").update(request.pkceVerifier).digest("base64url"),
			);
		} finally {
			await oidcServer.close();
		}
	});
});
