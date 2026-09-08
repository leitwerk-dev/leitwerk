import { type Actor, ADMIN_ACTOR } from "@leitwerk-dev/domain";
import { describe, expect, it } from "vitest";
import { createInMemoryDatabase } from "../db/database.js";
import { createAllRepos } from "../db/repositories.js";
import { resolveApiTokenPolicy, tokenExpiry } from "./api-token-policy.js";
import { createAuthService } from "./auth-service.js";
import { testAuthConfig } from "./auth-test-helpers.js";
import { hashOpaqueToken } from "./auth-tokens.js";

const alice: Actor = { id: "identity:alice", kind: "user", provider: "identity" };
function harness(config = testAuthConfig(), repos = createAllRepos(createInMemoryDatabase())) {
	const auth = createAuthService({ config, repos });
	return { auth, repos, service: auth.apiTokens };
}
describe("API token policy", () => {
	it("defaults dated tokens, permits explicit no expiration and enforces boundaries", () => {
		const policy = resolveApiTokenPolicy();
		const now = Date.now();
		expect(tokenExpiry(policy, undefined, now)).toBe(new Date(now + 7 * 86400000).toISOString());
		expect(tokenExpiry(policy, null, now)).toBeNull();
		expect(tokenExpiry(policy, new Date(now + policy.maxTtlMs).toISOString(), now)).toBeTruthy();
		for (const value of [
			"bad",
			"1",
			"2026-02-30T00:00:00Z",
			new Date(now).toISOString(),
			new Date(now + policy.maxTtlMs + 1).toISOString(),
			123,
		])
			expect(() => tokenExpiry(policy, value, now)).toThrow();
		expect(() => tokenExpiry({ ...policy, allowNoExpiry: false }, null, now)).toThrow();
	});
	it.each([true, false])("validates configuration with auth enabled=%s", (enabled) => {
		for (const api_tokens of [
			{ default_ttl: "bad" },
			{ max_ttl: "0s" },
			{ default_ttl: "91d" },
			{ default_ttl: "-1m" },
		])
			expect(() => harness(testAuthConfig({ auth: { enabled, api_tokens } }))).toThrow();
	});
});
describe("API token ownership and lifecycle", () => {
	it.each([
		"oidc",
		"oauth2",
	] as const)("issues from pre-upgrade %s sessions; logout does not revoke", (kind) => {
		const config =
			kind === "oidc"
				? testAuthConfig()
				: testAuthConfig({
						auth: {
							providers: [
								{
									id: "github",
									kind: "oauth2",
									organization: "org",
									client_id: "client",
									client_secret: "secret",
								},
							],
						},
					});
		const actor = kind === "oidc" ? alice : { ...alice, id: "github:alice", provider: "github" };
		const { auth, repos, service } = harness(config);
		repos.authSessions.create({
			idHash: hashOpaqueToken("legacy-session"),
			actor,
			expiresAt: new Date(Date.now() + 60000).toISOString(),
		});
		const owner = service.ownerForActor(auth.resolveSession("legacy-session")!);
		const { token, secret } = service.create(owner, "automation", undefined);
		expect(secret).toMatch(/^lwk_pat_[A-Za-z0-9_-]{43}$/);
		expect(service.resolve(secret).actor).toEqual(actor);
		auth.logout("legacy-session");
		expect(auth.resolveSession("legacy-session")).toBeNull();
		expect(service.resolve(secret).actor).toEqual(actor);
		expect(service.list(owner)[0].lastUsedAt).not.toBeNull();
		expect(JSON.stringify(service.list(owner))).not.toContain(secret);
		expect(service.list(owner)[0]).not.toHaveProperty("secretHash");
		expect(service.revoke(owner, token.id)).toBe(true);
		expect(service.resolve(secret).actor).toBeNull();
	});
	it("binds OIDC issuer, identity claim and provider, and checks the current allowlist", () => {
		const { repos, service } = harness();
		const { secret } = service.create(service.ownerForActor(alice), "test", null);
		for (const config of [
			testAuthConfig({ provider: { issuer: "https://different.test" } }),
			testAuthConfig({ provider: { identity_claim: "email" } }),
			testAuthConfig({ provider: { id: "different" } }),
			testAuthConfig({ auth: { allowlist: [] } }),
			testAuthConfig({ auth: { enabled: false } }),
			testAuthConfig({ auth: { api_tokens: { enabled: false } } }),
		]) {
			expect(harness(config, repos).service.resolve(secret).actor).toBeNull();
		}
		expect(
			harness(testAuthConfig({ provider: { client_secret: "rotated" } }), repos).service.resolve(
				secret,
			).actor,
		).toEqual(alice);
	});
	it("binds GitHub organization without adding membership requests", () => {
		const config = testAuthConfig({
			auth: {
				providers: [
					{
						id: "github",
						kind: "oauth2",
						organization: "org",
						client_id: "client",
						client_secret: "secret",
					},
				],
			},
		});
		const { service, repos } = harness(config);
		const { secret } = service.create(
			service.ownerForActor({ ...alice, id: "github:alice", provider: "github" }),
			"test",
			null,
		);
		config.auth!.providers = [
			{
				id: "github",
				kind: "oauth2",
				organization: "other",
				client_id: "client",
				client_secret: "secret",
			},
		];
		expect(harness(config, repos).service.resolve(secret).actor).toBeNull();
	});
	it("isolates users and supports owner-wide revocation", () => {
		const { service } = harness(testAuthConfig({ auth: { allowlist: ["alice", "bob"] } }));
		const a = service.ownerForActor(alice),
			b = service.ownerForActor({ ...alice, id: "identity:bob" });
		const one = service.create(a, "one", null),
			two = service.create(b, "two", null);
		expect(service.list(b).map((t) => t.id)).toEqual([two.token.id]);
		expect(service.revoke(b, one.token.id)).toBe(false);
		expect(service.revokeAll(a)).toBe(1);
		expect(service.resolve(one.secret).actor).toBeNull();
		expect(service.resolve(two.secret).actor?.id).toBe(b.id);
	});
	it("expires exactly at expiry and never revives revoked anonymous tokens across auth toggles", () => {
		const config = testAuthConfig({ auth: { enabled: false } });
		const { service, repos } = harness(config);
		const owner = service.ownerForActor(ADMIN_ACTOR);
		const { secret } = service.create(owner, "anonymous", null);
		expect(owner.kind).toBe("anonymous");
		expect(service.resolve(secret).actor).toEqual(ADMIN_ACTOR);
		harness(testAuthConfig({ auth: { api_tokens: { enabled: false } } }), repos);
		expect(harness(config, repos).service.resolve(secret).actor).toBeNull();
		expect(harness(config, repos).service.list(owner)[0].revokedAt).not.toBeNull();
		const record = repos.apiTokens.findByHash(hashOpaqueToken(secret))!;
		repos.apiTokens.create({
			...record,
			id: "boundary",
			secretHash: hashOpaqueToken(`lwk_pat_${"a".repeat(43)}`),
			revokedAt: null,
			expiresAt: new Date().toISOString(),
		});
		expect(service.resolve(`lwk_pat_${"a".repeat(43)}`).actor).toBeNull();
	});
});
