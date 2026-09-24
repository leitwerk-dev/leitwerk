// @vitest-environment jsdom
import { ADMIN_ACTOR } from "@leitwerk-dev/domain";
import { mount, unmount } from "svelte";
import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";
import { createApiToken, fetchApiTokens, revokeApiToken } from "../lib/api-tokens.js";
import ApiTokensPage from "./ApiTokensPage.svelte";

vi.mock("../lib/api-tokens.js", () => ({
	createApiToken: vi.fn(),
	fetchApiTokens: vi.fn(),
	revokeApiToken: vi.fn(),
}));
const token = {
	id: "public-id",
	prefix: "lwk_pat_display",
	name: "Automation",
	createdAt: "2026-09-08T00:00:00Z",
	expiresAt: null,
	revokedAt: null,
	lastUsedAt: null,
};
const data = {
	tokens: [token],
	policy: { enabled: true, defaultTtlMs: 604800000, maxTtlMs: 7776000000, allowNoExpiry: true },
	csrfToken: "csrf",
};
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
let app: ReturnType<typeof mount> | undefined;
async function render() {
	const target = document.createElement("div");
	document.body.append(target);
	app = mount(ApiTokensPage, { target, props: { authEnabled: false, actor: ADMIN_ACTOR } });
	await flush();
	return target;
}
function button(target: HTMLElement, label: string) {
	const button = [...target.querySelectorAll("button")].find(
		(b) => b.textContent?.trim() === label,
	);
	assert(button, `Expected button '${label}'`);
	return button;
}
beforeEach(() => {
	vi.mocked(fetchApiTokens).mockResolvedValue(structuredClone(data));
	vi.mocked(revokeApiToken).mockResolvedValue({ ok: true });
});
afterEach(async () => {
	if (app) await unmount(app);
	app = undefined;
	document.body.innerHTML = "";
	if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
	else Reflect.deleteProperty(navigator, "clipboard");
	vi.resetAllMocks();
});
it("shows anonymous ownership, metadata, expiration choices and revoke-all confirmation", async () => {
	const target = await render();
	expect(target.textContent).toContain("Every visitor shares");
	expect(target.textContent).toContain("public-id");
	expect(target.textContent).toContain("No expiration");
	expect(target.querySelector('option[value="canary"]')?.textContent).toBe("30 minutes");
	button(target, "Revoke all tokens").click();
	await flush();
	expect(revokeApiToken).not.toHaveBeenCalled();
	button(target, "Confirm revoke all").click();
	await flush();
	expect(revokeApiToken).toHaveBeenCalledWith("csrf", undefined);
});
it("holds the new secret only for once-only display and gives copy success/failure feedback", async () => {
	vi.mocked(createApiToken).mockResolvedValue({
		token: { ...token, id: "new-id" },
		secret: "lwk_pat_once_only",
	});
	const copy = vi.fn().mockResolvedValue(undefined);
	Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copy } });
	const target = await render();
	const input = target.querySelector<HTMLInputElement>("#token-name");
	assert(input, "Expected the token name input");
	input.value = "canary";
	input.dispatchEvent(new Event("input", { bubbles: true }));
	await flush();
	const form = target.querySelector("form");
	assert(form, "Expected the token creation form");
	form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
	await flush();
	expect(target.querySelector<HTMLTextAreaElement>("#new-token")?.value).toBe("lwk_pat_once_only");
	button(target, "Copy token").click();
	await flush();
	expect(target.textContent).toContain("Copied to clipboard");
	expect(copy).toHaveBeenCalledWith("lwk_pat_once_only");
	copy.mockRejectedValueOnce(new Error("denied"));
	button(target, "Copy token").click();
	await flush();
	expect(target.textContent).toContain("Copy failed");
	button(target, "I saved it — dismiss").click();
	await flush();
	expect(target.querySelector("#new-token")).toBeNull();
	expect(localStorage.length).toBe(0);
	expect(sessionStorage.length).toBe(0);
});
it("keeps revocation available when issuance is disabled and reports failures", async () => {
	vi.mocked(fetchApiTokens).mockResolvedValue({
		...structuredClone(data),
		policy: { ...data.policy, enabled: false },
	});
	vi.mocked(revokeApiToken).mockRejectedValueOnce(new Error("Network unavailable"));
	const target = await render();
	expect(target.textContent).toContain("Token issuance is disabled");
	expect(target.querySelector("form")).toBeNull();
	button(target, "Revoke").click();
	await flush();
	expect(target.querySelector('[role="alert"]')?.textContent).toContain("Network unavailable");
});
it("reports a loading error and allows retry", async () => {
	vi.mocked(fetchApiTokens).mockRejectedValueOnce(new Error("Offline"));
	const target = await render();
	expect(target.textContent).toContain("Offline");
	button(target, "Try again").click();
	await flush();
	expect(target.textContent).toContain("Automation");
});
