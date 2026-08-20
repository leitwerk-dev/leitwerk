import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import showcaseProcessesExtension from "@leitwerk-dev/showcase-processes";
import { expect, test } from "./fixtures.js";

test.use({
	viewport: { width: 390, height: 844 },
	browserServerOptions: {
		tempPrefix: "leitwerk-mobile-sidebar-browser-",
		createExtensionCatalog: () => buildExtensionCatalogFromModules([showcaseProcessesExtension]),
	},
});

test("keeps mobile navigation reachable and hides the drawer until requested", async ({
	page,
	leitwerk,
}) => {
	const process = leitwerk.ctx.deps.processes.create({
		processId: "single_prompt_process",
		selectedTurnId: "run_single_prompt",
		lifecycleStatus: "active",
		externalId: "MOBILE-SIDEBAR-001",
	});
	await page.goto(`/processes/${process.id}`);
	await page.waitForSelector('[data-page="process-detail"]');

	const menuButton = page.getByRole("button", { name: "Open navigation" });
	const drawer = page.locator('[data-mobile-sidebar="drawer"]');
	const sidebar = drawer.locator('[data-column="sidebar"]');

	await expect(menuButton).toBeVisible();
	await expect(menuButton).toBeInViewport();
	await expect(sidebar).not.toBeVisible();

	await menuButton.click();
	await expect(menuButton).toHaveAttribute("aria-expanded", "true");
	await expect(drawer).toHaveAttribute("role", "dialog");
	await expect(sidebar).toBeVisible();
	await expect(drawer.getByRole("button", { name: "Close navigation" })).toBeFocused();

	await page.keyboard.press("Escape");
	await expect(sidebar).not.toBeVisible();
	await expect(menuButton).toBeFocused();

	await page.goto("/");
	await page.waitForSelector('[data-page="home"]');
	await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
	await expect(menuButton).toBeInViewport();

	await menuButton.click();
	await drawer.getByRole("link", { name: "All processes" }).click();
	await expect(page).toHaveURL(/\/processes$/);
	await expect(sidebar).not.toBeVisible();
});
