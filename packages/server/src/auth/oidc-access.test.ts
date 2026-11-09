import type { Actor } from "@leitwerk-dev/domain";
import { describe, expect, it } from "vitest";
import type { OidcAccessPolicy } from "../config/config-types.js";
import { createAllRepos } from "../db/repositories.js";
import { createOwnedInMemoryDatabase } from "../test-helpers/owned-test-deps.js";
import { isActorAllowedByConfig, resolveAuthConfig } from "./auth-config.js";
import { createAuthService } from "./auth-service.js";
import {
	createTestOidcLogin,
	createTestSessionOwner,
	testAuthConfig,
	testOidcEvidence,
} from "./auth-test-helpers.js";
import { hashOpaqueToken } from "./auth-tokens.js";
import { safeClaims } from "./oidc-evidence.js";

const actor: Actor = { id: "identity:alice", kind: "user", provider: "identity" };
const policy: OidcAccessPolicy = {
	mode: "restricted",
	users: ["alice", "bob"],
	groups: ["operators"],
	email_domains: ["example.com"],
};
function config(access: OidcAccessPolicy) {
	return testAuthConfig({ auth: { allowlist: undefined }, provider: { access } });
}
const claims = { groups: ["other", "operators"], email: "alice@EXAMPLE.COM", email_verified: true };

describe("OIDC admission", () => {
	it.each([
		undefined,
		"all",
		"any",
	] as const)("supports match=%s and any entry within each list", (match) => {
		const auth = resolveAuthConfig(config({ ...policy, match }));
		expect(isActorAllowedByConfig(actor, auth, testOidcEvidence("alice", claims))).toBe(true);
		expect(
			isActorAllowedByConfig(actor, auth, testOidcEvidence("alice", { ...claims, groups: [] })),
		).toBe(match === "any");
		expect(
			isActorAllowedByConfig(
				actor,
				auth,
				testOidcEvidence("alice", { groups: [], email_verified: false }),
			),
		).toBe(match === "any");
	});
	it.each([
		{},
		{ groups: "operators" },
		{ groups: ["operators", 42] },
		{ groups: ["Operators"] },
	])("rejects missing or malformed groups: %j", (extra) => {
		expect(
			isActorAllowedByConfig(
				actor,
				resolveAuthConfig(config({ mode: "restricted", groups: ["operators"] })),
				testOidcEvidence("alice", extra),
			),
		).toBe(false);
	});
	it("uses the configured group claim and exact case-sensitive membership", () => {
		const auth = resolveAuthConfig(
			config({ mode: "restricted", groups: ["operators"], groups_claim: "roles" }),
		);
		expect(
			isActorAllowedByConfig(actor, auth, testOidcEvidence("alice", { roles: ["operators"] })),
		).toBe(true);
		expect(
			isActorAllowedByConfig(actor, auth, testOidcEvidence("alice", { groups: ["operators"] })),
		).toBe(false);
	});
	it.each([
		{ email: "alice@example.com", email_verified: false },
		{ email: "alice@example.com", email_verified: "true" },
		{ email: "alice@example.com" },
		{ email: "alice@sub.example.com", email_verified: true },
		{ email: "a@b@example.com", email_verified: true },
		{ email: ["alice@example.com"], email_verified: true },
		{ email: "alice@example.com ", email_verified: true },
	])("requires an exact verified email domain: %j", (extra) => {
		const auth = resolveAuthConfig(config({ mode: "restricted", email_domains: ["EXAMPLE.COM"] }));
		expect(isActorAllowedByConfig(actor, auth, testOidcEvidence("alice", extra))).toBe(false);
	});
	it("explicit all still requires authenticated, bound subject evidence", () => {
		const auth = resolveAuthConfig(config({ mode: "all" }));
		expect(isActorAllowedByConfig(actor, auth)).toBe(false);
		expect(isActorAllowedByConfig(actor, auth, testOidcEvidence())).toBe(true);
		for (const evidence of [
			{ ...testOidcEvidence(), issuer: "https://other.test" },
			{ ...testOidcEvidence(), subject: "" },
			{ ...testOidcEvidence(), userInfoClaims: { sub: "someone-else" } },
			testOidcEvidence("bob"),
		])
			expect(isActorAllowedByConfig(actor, auth, evidence)).toBe(false);
	});
	it("keeps legacy identity admission, but requires evidence for old credentials", () => {
		const auth = resolveAuthConfig(testAuthConfig());
		expect(isActorAllowedByConfig(actor, auth, testOidcEvidence())).toBe(true);
		expect(isActorAllowedByConfig(actor, auth)).toBe(false);
		expect(
			isActorAllowedByConfig({ ...actor, id: "identity:bob" }, auth, testOidcEvidence("bob")),
		).toBe(false);
	});
	it("reevaluates both sessions and tokens against current policy, without leaking claims into actors", () => {
		const repos = createAllRepos(createOwnedInMemoryDatabase());
		const evidence = testOidcEvidence("alice", claims);
		const initial = createAuthService({ config: config(policy), repos });
		repos.authSessions.create({
			idHash: hashOpaqueToken("session"),
			actor,
			oidcEvidence: evidence,
			expiresAt: new Date(Date.now() + 60000).toISOString(),
		});
		const { secret } = initial.apiTokens.create(
			createTestSessionOwner(initial, repos, actor, evidence),
			"test",
			null,
		);
		expect(initial.resolveSession("session")).toEqual(actor);
		expect(initial.apiTokens.resolve(secret).actor).toEqual(actor);
		const any = createAuthService({
			config: config({ ...policy, groups: ["missing"], match: "any" }),
			repos,
		});
		expect(any.resolveSession("session")).toEqual(actor);
		expect(any.apiTokens.resolve(secret).actor).toEqual(actor);
		const all = createAuthService({
			config: config({ ...policy, groups: ["missing"], match: "all" }),
			repos,
		});
		expect(all.resolveSession("session")).toBeNull();
		expect(all.apiTokens.resolve(secret).actor).toBeNull();
	});
	it("fails closed for existing tokens and sessions without evidence", () => {
		const repos = createAllRepos(createOwnedInMemoryDatabase());
		const auth = createAuthService({ config: config({ mode: "all" }), repos });
		repos.authSessions.create({
			idHash: hashOpaqueToken("old"),
			actor,
			expiresAt: new Date(Date.now() + 60000).toISOString(),
		});
		expect(auth.resolveSession("old")).toBeNull();
		const issued = auth.apiTokens.create(
			createTestSessionOwner(auth, repos, actor, testOidcEvidence()),
			"test",
			null,
		);
		const stored = repos.apiTokens.findByHash(hashOpaqueToken(issued.secret));
		if (!stored) throw new Error("Expected stored token");
		const legacySecret = `lwk_pat_${"a".repeat(43)}`;
		repos.apiTokens.create({
			...stored,
			id: "legacy",
			secretHash: hashOpaqueToken(legacySecret),
			owner: { ...stored.owner, oidcEvidence: null },
		});
		expect(auth.apiTokens.resolve(legacySecret).actor).toBeNull();
	});
	it.each([
		{ idTokenClaims: { preferred_username: "alice" }, userInfoClaims: null },
		{ idTokenClaims: { sub: "" }, userInfoClaims: null },
		{ idTokenClaims: { sub: "subject-alice" }, userInfoClaims: { sub: "other" } },
	])("rejects invalid subject evidence during login: %j", async (evidence) => {
		const { completeLogin } = createTestOidcLogin(config({ mode: "all" }), {
			result: { claims: { preferred_username: "alice" }, ...evidence },
		});
		await expect(completeLogin()).rejects.toThrow("subject");
	});
	it("retains source-labeled safe login evidence and cannot bypass missing criteria on fallback", async () => {
		const idTokenClaims = {
			sub: "subject-alice",
			preferred_username: "alice",
			name: "Alice",
			access_token: "must-not-retain",
		};
		for (const match of ["all", "any"] as const) {
			const { auth, completeLogin } = createTestOidcLogin(config({ ...policy, match }), {
				claims: idTokenClaims,
			});
			const completion = completeLogin();
			if (match === "all") await expect(completion).rejects.toThrow("admission policy");
			else {
				const login = await completion;
				expect(login.actor).toEqual({ ...actor, displayName: "Alice" });
				const information = auth.userInformation(login.sessionCookieValue);
				expect(information).toMatchObject({
					idTokenClaims: { sub: "subject-alice" },
					userInfoClaims: null,
					facts: { identity: "alice", groups: [], email: null, emailVerified: false },
				});
				expect(JSON.stringify(information)).not.toContain("must-not-retain");
				expect(Date.parse(information?.loginAt ?? "")).toBeLessThanOrEqual(Date.now());
				expect(Date.parse(information?.loginAt ?? "")).toBeGreaterThan(Date.now() - 60000);
			}
		}
	});
	it("removes credential-shaped claims recursively", () => {
		expect(
			safeClaims({
				sub: "alice",
				access_token: "secret",
				nested: {
					refresh_token: "secret",
					id_token: "secret",
					client_secret: "secret",
					roles: ["a"],
				},
			}),
		).toEqual({ sub: "alice", nested: { roles: ["a"] } });
	});
});
