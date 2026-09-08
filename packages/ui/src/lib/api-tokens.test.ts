import { afterEach, expect, it, vi } from "vitest";
import { createApiToken, fetchApiTokens, revokeApiToken } from "./api-tokens.js";

const configKey = Symbol.for("leitwerk.uiRuntimeTransportConfig");
const runtime = globalThis as typeof globalThis & { [configKey]?: { fetchImpl: typeof fetch } };
afterEach(() => {
	delete runtime[configKey];
});

it("keeps token requests uncached and browser-bound, omitting undefined expiry", async () => {
	const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));
	runtime[configKey] = { fetchImpl };
	await fetchApiTokens();
	await createApiToken("csrf", { name: "automation", expiresAt: undefined });
	await revokeApiToken("csrf", "id/with/slash");
	await revokeApiToken("csrf");
	expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
		"/api/auth/tokens",
		"/api/auth/tokens",
		"/api/auth/tokens/id%2Fwith%2Fslash",
		"/api/auth/tokens",
	]);
	for (const [, init] of fetchImpl.mock.calls) {
		expect(init).toMatchObject({ credentials: "same-origin", cache: "no-store" });
	}
	expect(fetchImpl.mock.calls[1][1]).toMatchObject({
		method: "POST",
		headers: { "content-type": "application/json", "x-csrf-token": "csrf" },
		body: '{"name":"automation"}',
	});
	for (const [, init] of fetchImpl.mock.calls.slice(2)) {
		expect(init).toMatchObject({ method: "DELETE", headers: { "x-csrf-token": "csrf" } });
	}
});

it.each([
	[403, '{"error":"API token issuance is disabled"}', "API token issuance is disabled"],
	[502, "Bad gateway", "Request failed (502)"],
	[200, "null", "Malformed API token response"],
])("reports token response errors for HTTP %s", async (status, body, message) => {
	runtime[configKey] = { fetchImpl: async () => new Response(body, { status }) };
	await expect(fetchApiTokens()).rejects.toThrow(message);
});
