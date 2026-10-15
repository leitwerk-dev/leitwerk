import exampleProcessesExtension from "@leitwerk-dev/example-processes";
import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import { createDashboardFixture } from "@leitwerk-dev/test-support/fixtures";
import { expect, expectNoPageOverflow, test } from "./fixtures.js";

test.use({
	reducedMotion: "reduce",
	browserServerOptions: {
		tempPrefix: "leitwerk-dashboard-browser-",
		createExtensionCatalog: () => buildExtensionCatalogFromModules([exampleProcessesExtension]),
	},
});

test.beforeEach(async ({ page, leitwerk }) => {
	void leitwerk;
	await page.route("**/api/dashboard", (route) =>
		route.fulfill({ json: createDashboardFixture() }),
	);
});

test("root overview opens creation and resource catalogs", async ({ page }) => {
	const dashboard = page.locator('[data-page="dashboard"]');
	for (const [name, url, destination] of [
		[/^Start a process$/, /\/processes\/new$/, "home"],
		[/Process definitions/, /\/processes\/new$/, "home"],
		[/Watchers/, /\/watchers$/, "watchers"],
		[/Skills/, /\/skills$/, "skills"],
	] as const) {
		await page.goto("/");
		await expect(dashboard.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
		await dashboard.getByRole("link", { name }).click();
		await expect(page).toHaveURL(url);
		await expect(page.locator(`[data-page="${destination}"]`)).toBeVisible();
	}
});

test("groups retained processes and expands model costs and readiness issues", async ({
	page,
}, testInfo) => {
	await page.setViewportSize({ width: 1440, height: 1500 });
	await page.goto("/");
	const dashboard = page.locator('[data-page="dashboard"]');
	await expect(dashboard.locator(".cost-total")).toHaveText("$8.40");
	await expect(dashboard.locator(".status-list dt")).toHaveText([
		"Running",
		"Waiting",
		"Error",
		"Completed",
		"Aborted",
	]);
	await page.evaluate(() => document.fonts.ready);
	const screenshotPath = testInfo.outputPath("dashboard-desktop.png");
	await page.screenshot({ path: screenshotPath, fullPage: true });
	await testInfo.attach("dashboard-desktop", {
		path: screenshotPath,
		contentType: "image/png",
	});
	await dashboard.getByRole("button", { name: "By definition" }).click();
	await expect(dashboard.getByRole("button", { name: "By definition" })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(dashboard.locator(".ranked .row-label")).toHaveText([
		"Single Prompt14",
		"Poem Creator8",
		"Repository Change5",
	]);
	await expect(dashboard.locator(".cost-list li")).toHaveCount(5);
	await dashboard.getByRole("button", { name: "Show all 6 models" }).click();
	await expect(dashboard.locator(".cost-list li")).toHaveCount(6);
	await expect(dashboard.getByRole("button", { name: "Show fewer models" })).toHaveAttribute(
		"aria-expanded",
		"true",
	);
	await dashboard.getByRole("button", { name: "Show all 4 issues" }).click();
	await expect(dashboard.locator(".issues li")).toHaveCount(4);
	await dashboard.getByRole("button", { name: "Show fewer issues" }).click();
	await expect(dashboard.locator(".issues li")).toHaveCount(3);
});

test("mobile overview stays within the viewport and exposes dashboard navigation", async ({
	page,
}, testInfo) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto("/");
	await expect(page.locator('[data-page="dashboard"] .cost-total')).toBeVisible();
	await expectNoPageOverflow(page);
	await page.evaluate(() => document.fonts.ready);
	const screenshotPath = testInfo.outputPath("dashboard-mobile.png");
	await page.screenshot({ path: screenshotPath, fullPage: true });
	await testInfo.attach("dashboard-mobile", {
		path: screenshotPath,
		contentType: "image/png",
	});
	await page.getByRole("button", { name: "Open navigation" }).click();
	const drawer = page.locator('[data-mobile-sidebar="drawer"]');
	await expect(drawer.getByRole("link", { name: "Dashboard", exact: true })).toHaveAttribute(
		"aria-current",
		"page",
	);
	await expectNoPageOverflow(page);
	await drawer.getByRole("link", { name: "Start a process", exact: true }).click();
	await expect(page).toHaveURL(/\/processes\/new$/);
	await expect(page.getByRole("button", { name: "Open navigation" })).toHaveAttribute(
		"aria-expanded",
		"false",
	);
});

test("legacy launcher links replace the root URL with the creation URL", async ({ page }) => {
	await page.goto("/?launcher=single_prompt_process.single_prompt_ui");
	await expect(page).toHaveURL(
		/\/processes\/new\?launcher=single_prompt_process\.single_prompt_ui$/,
	);
	await expect(page.locator('[data-page="home"]')).toBeVisible();
	await expect(page.locator('[data-section="launcher-form"]')).toBeVisible();
});
