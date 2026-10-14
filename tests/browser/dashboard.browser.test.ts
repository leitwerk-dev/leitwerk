import exampleProcessesExtension from "@leitwerk-dev/example-processes";
import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import type { DashboardResponseBody } from "@leitwerk-dev/protocol";
import { expect, expectNoPageOverflow, test } from "./fixtures.js";

// Keep the browser overview stable while exercising real SPA routes and catalogs.
const dashboardFixture: DashboardResponseBody = {
	generatedAt: "2026-10-14T10:30:00.000Z",
	definitions: {
		total: 4,
		items: [
			{ id: "single_prompt_process", name: "Single Prompt" },
			{ id: "poem_creator_process", name: "Poem Creator" },
			{ id: "repo_change", name: "Repository Change" },
			{ id: "smoke", name: "Kubernetes Smoke" },
		],
	},
	watchers: {
		total: 4,
		enabled: 3,
		items: [
			{ id: "poem", name: "Poem file", enabled: true },
			{ id: "repo", name: "Repository issues", enabled: true },
			{ id: "schedule", name: "Scheduled checks", enabled: true },
			{ id: "paused", name: "Paused trigger", enabled: false },
		],
	},
	skills: { total: 9, installed: 4, bundled: 5 },
	processes: {
		total: 27,
		byStatus: [
			{ status: "running", count: 3 },
			{ status: "waiting", count: 5 },
			{ status: "error", count: 2 },
			{ status: "completed", count: 16 },
			{ status: "aborted", count: 1 },
		],
		byDefinition: [
			{ processId: "single_prompt_process", name: "Single Prompt", count: 14 },
			{ processId: "poem_creator_process", name: "Poem Creator", count: 8 },
			{ processId: "repo_change", name: "Repository Change", count: 5 },
		],
	},
	costs: {
		totalUsd: 8.4,
		totalLlmTurnCount: 65,
		pricedTurnCount: 60,
		missingCostTurnCount: 5,
		isPartial: true,
		byModel: [
			"gpt-6.1",
			"gpt-6",
			"gpt-6-mini",
			"claude-sonnet",
			"claude-haiku",
			"historical-model",
		].map((modelId, index) => ({
			providerId: index < 3 ? "openai" : "anthropic",
			modelId,
			costUsd: (6 - index) * 0.4,
			turnCount: 10,
		})),
	},
	configuration: {
		issues: [
			{
				id: "credential",
				code: "missing_credential",
				severity: "error",
				message: "The review model profile needs a provider credential.",
				sources: [{ label: "Review model", href: "/settings" }],
			},
			{
				id: "default",
				code: "missing_default",
				severity: "warning",
				message: "Repository Change has no default model profile.",
				sources: [{ label: "Repository Change", href: "/settings" }],
			},
			{
				id: "unavailable",
				code: "unavailable_model",
				severity: "error",
				message: "A configured model is unavailable from its provider.",
				sources: [{ label: "Model catalog", href: "/settings" }],
			},
			{
				id: "override",
				code: "invalid_override",
				severity: "warning",
				message: "A turn override references a removed model profile.",
				sources: [{ label: "Turn settings", href: "/settings" }],
			},
		],
	},
};

test.use({
	reducedMotion: "reduce",
	browserServerOptions: {
		tempPrefix: "leitwerk-dashboard-browser-",
		createExtensionCatalog: () => buildExtensionCatalogFromModules([exampleProcessesExtension]),
	},
});

test.beforeEach(async ({ page, leitwerk }) => {
	void leitwerk;
	await page.route("**/api/dashboard", (route) => route.fulfill({ json: dashboardFixture }));
});

test("root overview opens creation and resource catalogs", async ({ page }) => {
	await page.goto("/");
	const dashboard = page.locator('[data-page="dashboard"]');
	await expect(dashboard.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
	await dashboard.getByRole("link", { name: "Start a process", exact: true }).click();
	await expect(page).toHaveURL(/\/processes\/new$/);
	await expect(page.locator('[data-page="home"]')).toBeVisible();
	await page.goto("/");
	await dashboard.getByRole("link", { name: /Process definitions/ }).click();
	await expect(page).toHaveURL(/\/processes\/new$/);
	await page.goto("/");
	await dashboard.getByRole("link", { name: /Watchers/ }).click();
	await expect(page).toHaveURL(/\/watchers$/);
	await expect(page.locator('[data-page="watchers"]')).toBeVisible();
	await page.goto("/");
	await dashboard.getByRole("link", { name: /Skills/ }).click();
	await expect(page).toHaveURL(/\/skills$/);
	await expect(page.locator('[data-page="skills"]')).toBeVisible();
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
