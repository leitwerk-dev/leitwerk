import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import type { ResolvedAuthProvider } from "./auth-config.js";
import { createOpenIdClient } from "./oidc-client.js";

async function startLocalOidcMetadataServer(): Promise<{
	issuer: string;
	close: () => Promise<void>;
}> {
	let issuer = "";
	const server: Server = createServer((request, response) => {
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

function providerWithIssuer(issuer: string): ResolvedAuthProvider {
	return {
		id: "forgejo",
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
		} finally {
			await oidcServer.close();
		}
	});
});
