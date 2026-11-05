import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { stringify } from "yaml";
import { testAuthConfig } from "../auth/auth-test-helpers.js";
import { loadConfigFromFile, validateConfig } from "./config-loader.js";
import type { OidcAccessPolicy } from "./config-types.js";

function validConfig() {
	const config = testAuthConfig();
	config.pi.default_model_profile = "test";
	config.pi.model_profiles = [{ id: "test", provider: "test", model_id: "test" }];
	return config;
}
function loadSecret(secret: string) {
	const root = mkdtempSync(join(tmpdir(), "leitwerk-oidc-config-"));
	onTestFinished(() => rmSync(root, { recursive: true, force: true }));
	const config = validConfig();
	const provider = config.auth?.providers?.[0];
	if (!provider) throw new Error("Missing test provider");
	provider.client_secret = secret;
	const path = join(root, "leitwerk.yaml");
	writeFileSync(path, stringify(config));
	return loadConfigFromFile(path);
}

describe("OIDC configuration", () => {
	it.each([
		{ mode: "all", users: ["alice"] },
		{ mode: "all", match: "any" },
		{ mode: "all", groups_claim: "roles" },
		{ mode: "restricted" },
		{ mode: "restricted", groups: [] },
		{ mode: "restricted", users: [" "] },
		{ mode: "restricted", email_domains: ["*.example.com"] },
		{ mode: "restricted", users: ["alice"], match: "none" },
	])("rejects contradictory or invalid policy %j", (access) => {
		const config = validConfig();
		if (!config.auth) throw new Error("Missing auth");
		config.auth.allowlist = undefined;
		const provider = config.auth.providers?.[0];
		if (provider?.kind !== "oidc") throw new Error("Missing provider");
		provider.access = access as OidcAccessPolicy;
		expect(validateConfig(config as unknown as Record<string, unknown>).join("\n")).toContain(
			"access",
		);
	});
	it.each([
		"all",
		"any",
	] as const)("accepts match=%s but rejects combination with legacy allowlist", (match) => {
		const config = validConfig();
		const provider = config.auth?.providers?.[0];
		if (!config.auth || provider?.kind !== "oidc") throw new Error("Missing provider");
		provider.access = { mode: "restricted", match, groups: ["operators"] };
		expect(validateConfig(config as unknown as Record<string, unknown>).join("\n")).toContain(
			"allowlist",
		);
		config.auth.allowlist = undefined;
		expect(validateConfig(config as unknown as Record<string, unknown>)).toEqual([]);
		provider.access = { mode: "all" };
		expect(validateConfig(config as unknown as Record<string, unknown>)).toEqual([]);
	});
	it("retains legacy allowlist configuration", () => {
		expect(validateConfig(validConfig() as unknown as Record<string, unknown>)).toEqual([]);
	});
	it("expands only OIDC client_secret once, preserving literals and non-recursive variable contents", () => {
		vi.stubEnv("LEITWERK_TEST_SECRET", "resolved-${DO_NOT_EXPAND}");
		onTestFinished(() => vi.unstubAllEnvs());
		const loaded = loadSecret("prefix-${LEITWERK_TEST_SECRET}-suffix");
		expect(loaded.ok).toBe(true);
		if (!loaded.ok) throw new Error(loaded.error);
		expect(loaded.config.auth?.providers?.[0].client_secret).toBe(
			"prefix-resolved-${DO_NOT_EXPAND}-suffix",
		);
		expect(loadSecret("literal-$value")).toMatchObject({
			ok: true,
			config: { auth: { providers: [{ client_secret: "literal-$value" }] } },
		});
	});
	it.each([
		undefined,
		"",
	])("rejects missing or empty variables without secret disclosure (%s)", (value) => {
		vi.stubEnv("LEITWERK_TEST_MISSING", value);
		vi.stubEnv("LEITWERK_TEST_SECRET", "never-show-this");
		onTestFinished(() => vi.unstubAllEnvs());
		const loaded = loadSecret("${LEITWERK_TEST_SECRET}-${LEITWERK_TEST_MISSING}");
		expect(loaded).toMatchObject({
			ok: false,
			error: expect.stringContaining("client_secret: environment variable LEITWERK_TEST_MISSING"),
		});
		expect(JSON.stringify(loaded)).not.toContain("never-show-this");
	});
});
