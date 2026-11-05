import { mkdir } from "node:fs/promises";
import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import { expect, expectNoPageOverflow, test } from "./fixtures.js";

test.use({
	browserServerOptions: {
		tempPrefix: "leitwerk-user-information-browser-",
		createExtensionCatalog: () => buildExtensionCatalogFromModules([]),
	},
});
for (const viewport of [
	{ name: "desktop", width: 1440, height: 900 },
	{ name: "mobile", width: 390, height: 844 },
]) {
	test(`${viewport.name}: inspect last-login claims, keyboard navigation and recovery`, async ({
		page,
		leitwerk: _leitwerk,
	}) => {
		await page.setViewportSize(viewport);
		await page.route("**/api/auth/me", (route) =>
			route.fulfill({
				json: {
					authEnabled: true,
					actor: { id: "company:alice", kind: "user", provider: "company", displayName: "Alice" },
					userInformationAvailable: true,
				},
			}),
		);
		let fail = true;
		const initialResponse = Promise.withResolvers<void>();
		await page.route("**/api/auth/user-information", async (route) => {
			if (fail) await initialResponse.promise;
			return route.fulfill(
				fail
					? { status: 503, json: { error: "Unavailable" } }
					: {
							json: {
								providerId: "company",
								issuer: "https://identity.example.com",
								subject: "subject-alice",
								loginAt: "2026-01-01T12:00:00.000Z",
								facts: {
									identity: "alice",
									email: "alice@example.com",
									emailVerified: true,
									groups: ["leitwerk-users", "operators"],
								},
								idTokenClaims: {
									sub: "subject-alice",
									name: "Alice Example",
									custom: "<img src=x onerror=alert(1)>",
									nested: { roles: ["operator"] },
								},
								userInfoClaims: {
									sub: "subject-alice",
									email: "alice@example.com",
									email_verified: true,
								},
							},
						},
			);
		});
		await page.goto("/");
		if (viewport.name === "mobile")
			await page.getByRole("button", { name: "Open navigation" }).click();
		const trigger = page.getByRole("button", { name: "User menu for Alice" });
		await trigger.click();
		await page.getByRole("button", { name: "User information", exact: true }).click();
		const dialog = page.getByRole("dialog", { name: "User information", exact: true });
		await expect(dialog).toBeVisible();
		await expect(dialog.getByRole("status")).toHaveText("Loading user information…");
		initialResponse.resolve();
		await expect(dialog.getByRole("alert")).toContainText("Could not load user information");
		fail = false;
		await dialog.getByRole("button", { name: "Try again" }).click();
		await expect(dialog.getByText("Alice Example", { exact: true })).toBeVisible();
		await expect(dialog.getByText("alice@example.com · Verified", { exact: true })).toBeVisible();
		await expect(
			dialog.getByText("This information reflects your last login.", { exact: false }),
		).toBeVisible();
		const close = dialog.getByRole("button", { name: "Close user information" });
		await close.focus();
		await page.keyboard.press("Tab");
		// Firefox includes the scrollable information region in native tab order.
		if (
			!(await dialog.locator("summary").evaluate((element) => element === document.activeElement))
		)
			await page.keyboard.press("Tab");
		await expect(dialog.locator("summary")).toBeFocused();
		await page.keyboard.press("Enter");
		await expect(dialog.getByRole("heading", { name: "ID token claims" })).toBeVisible();
		await expect(dialog.locator("pre").first()).toContainText("<img src=x onerror=alert(1)>");
		await expect(dialog.locator("img")).toHaveCount(0);
		await page.keyboard.press("Tab");
		await expect(close).toBeFocused();
		await expectNoPageOverflow(page);
		if (process.env.LEITWERK_USER_INFO_UI_REVIEW === "1") {
			await mkdir(".impeccable/review", { recursive: true });
			await page.screenshot({ path: `.impeccable/review/user-information-${viewport.name}.png` });
		}
		await page.keyboard.press("Escape");
		await expect(dialog).toHaveCount(0);
		await expect(trigger).toBeFocused();
	});
}
