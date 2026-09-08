import { mkdir } from "node:fs/promises";
import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import { expect, test } from "./fixtures.js";

test.use({
	browserServerOptions: {
		tempPrefix: "leitwerk-api-tokens-browser-",
		configure(config) {
			config.server.base_url = "http://localhost:5199";
		},
		createExtensionCatalog: () => buildExtensionCatalogFromModules([]),
	},
});
for (const viewport of [
	{ name: "desktop", width: 1440, height: 900 },
	{ name: "mobile", width: 390, height: 844 },
]) {
	test(`${viewport.name}: create a 30-minute token, call the API, dismiss, reload and revoke`, async ({
		page,
		playwright,
		leitwerk: _leitwerk,
	}) => {
		await page.setViewportSize(viewport);
		await page.goto("/account/api-tokens");
		await expect(page.getByRole("heading", { name: "API tokens", exact: true })).toBeVisible();
		await expect(page.getByText("Every visitor shares the anonymous token owner")).toBeVisible();
		await page.getByLabel("Name", { exact: true }).fill(`${viewport.name} canary`);
		await page.getByLabel("Expiration", { exact: true }).selectOption("canary");
		await page.getByRole("button", { name: "Create token", exact: true }).click();
		await expect(page.getByRole("heading", { name: "Save your token now" })).toBeVisible();
		await expect(page.getByRole("heading", { name: "Save your token now" })).toBeFocused();
		await expect(page.getByRole("heading", { name: "Save your token now" })).toBeInViewport();
		const secret = await page.getByLabel("New API token", { exact: true }).inputValue();
		// An isolated client sends no browser session or management cookies.
		const client = await playwright.request.newContext({
			baseURL: "http://localhost:5199",
			extraHTTPHeaders: { authorization: `Bearer ${secret}` },
		});
		try {
			const me = await client.get("/api/auth/me");
			expect(me.status()).toBe(200);
			expect((await me.json()).actor.id).toBe("admin");
			expect((await client.get("/api/processes")).status()).toBe(200);
			expect((await client.get("/api/auth/tokens")).status()).toBe(401);
			await page.getByRole("button", { name: "I saved it — dismiss" }).click();
			await expect(page.getByLabel("Name", { exact: true })).toBeFocused();
			await expect(page.getByLabel("New API token", { exact: true })).toHaveCount(0);
			await page.reload();
			await expect(
				page.getByRole("heading", { name: `${viewport.name} canary`, exact: true }),
			).toBeVisible();
			await expect(page.getByLabel("New API token", { exact: true })).toHaveCount(0);
			expect(
				await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
			).toBe(true);
			if (process.env.LEITWERK_TOKEN_UI_REVIEW === "1") {
				await mkdir(".impeccable/review", { recursive: true });
				await page.screenshot({ path: `.impeccable/review/${viewport.name}.png`, fullPage: true });
				if (viewport.name === "desktop") {
					await page
						.getByRole("button", { name: `Revoke ${viewport.name} canary`, exact: true })
						.scrollIntoViewIfNeeded();
					await page.screenshot({ path: ".impeccable/review/desktop-list.png" });
				}
			}
			await page
				.getByRole("button", { name: `Revoke ${viewport.name} canary`, exact: true })
				.click();
			await expect(page.getByRole("status")).toContainText("Token revoked.");
			expect((await client.get("/api/auth/me")).status()).toBe(401);
		} finally {
			await client.dispose();
		}
	});
}
