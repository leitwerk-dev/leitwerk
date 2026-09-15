import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";

const usage = {
	attachedAllTime: 8,
	attachedLast30Days: 3,
	invokedAllTime: 4,
	invokedLast30Days: 2,
};
const installed = {
	id: "review",
	label: "Review changes",
	description: "Inspect a change before it ships",
	activeRevisionId: "skillrev_review",
	activeSourceRevision: "abcdef123456",
	registrationKind: "catalog",
	sourceRepositoryId: "shared",
	updateAvailable: false,
	usage,
};
const catalog = {
	repositories: [
		{
			id: "shared",
			label: "Shared skills",
			url: "https://example.test/shared.git",
			ref: "main",
			path: "skills",
			lastRefreshedAt: "2026-08-01T10:00:00.000Z",
			error: null,
		},
	],
	availableSkills: [],
	installedSkills: Array.from({ length: 6 }, (_, index) => ({
		...installed,
		id: index === 0 ? "review" : `skill-${index}`,
		label: index === 0 ? installed.label : `Operational skill ${index}`,
		activeRevisionId: `skillrev_${index}`,
	})),
};
const detail = {
	...installed,
	skillMarkdown: `# Review instructions\n\n${"Follow the repository review policy.\n\n".repeat(120)}`,
	processes: [],
	revisions: [
		{
			id: "skillrev_review",
			sourceRevision: "abcdef123456",
			importedAt: "2026-08-01T10:00:00.000Z",
			active: true,
		},
	],
};

const available = {
	repositoryId: "shared",
	id: "planning",
	label: "Plan repository work",
	description: "Turn a requested change into an implementation plan",
	sourcePath: "skills/planning",
	sourceRevision: "abcdef123456",
	registered: false,
	updateAvailable: false,
	conflict: false,
	stale: false,
	modelInvocable: true,
	usage,
};

async function mockSkills(page: Page) {
	await page.route("**/api/skills", (route) =>
		route.fulfill({ json: { ...catalog, availableSkills: [available] } }),
	);
	await page.route("**/api/skills/installed/review", (route) =>
		route.fulfill({ json: { skill: detail } }),
	);
	await page.route("**/api/skills/available/shared/planning", (route) =>
		route.fulfill({
			json: { skill: { ...available, skillMarkdown: detail.skillMarkdown, processes: [] } },
		}),
	);
}

test.use({
	browserServerOptions: {
		tempPrefix: "leitwerk-skills-browser-",
		createExtensionCatalog: () => buildExtensionCatalogFromModules([]),
	},
});

test.describe("skills responsive and keyboard behavior", () => {
	for (const viewport of [
		{ name: "desktop", width: 1440, height: 900 },
		{ name: "tablet", width: 1024, height: 768 },
		{ name: "phone", width: 390, height: 844 },
	]) {
		test(`${viewport.name} keeps the catalog and detail usable without horizontal overflow`, async ({
			page,
			leitwerk: _leitwerk,
		}) => {
			await page.setViewportSize(viewport);
			await mockSkills(page);
			await page.goto("/skills");
			await expect(page.locator('[data-page="skills"]')).toBeVisible();
			await expect(page.getByText("Review changes").first()).toBeVisible();
			expect(
				await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
			).toBe(true);
			const tableWrap = page.locator(".skill-table-wrap");
			expect(
				await tableWrap.evaluate((element) => element.scrollWidth <= element.clientWidth),
			).toBe(true);

			await page.goto("/skills/installed/review");
			const detailPane = page.locator(".detail-pane");
			await expect(detailPane).toBeVisible();
			await expect(page.getByRole("button", { name: "Remove" })).toBeVisible();
			expect((await detailPane.boundingBox())?.height ?? 0).toBeGreaterThan(
				Math.min(500, viewport.height * 0.55),
			);
			expect(
				await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
			).toBe(true);
			await expect(page.getByRole("heading", { name: "Instructions", exact: true })).toHaveCount(0);
			await page.getByRole("tab", { name: "Instructions" }).click();
			await expect(page.getByRole("heading", { name: "Instructions", exact: true })).toBeVisible();

			await page.goto("/skills");
			await page.getByRole("button", { name: "Available remotely 1", exact: true }).click();
			await page.getByRole("link", { name: /Plan repository work/ }).click();
			await expect(page.getByRole("button", { name: "Install skill", exact: true })).toBeVisible();
			if (viewport.name === "desktop") {
				const repositoryFilter = await page
					.getByRole("combobox", { name: "Repository", exact: true })
					.boundingBox();
				const stateFilter = await page
					.getByRole("combobox", { name: "Remote skill state", exact: true })
					.boundingBox();
				expect(repositoryFilter).not.toBeNull();
				expect(stateFilter).not.toBeNull();
				expect(Math.abs((repositoryFilter?.width ?? 0) - (stateFilter?.width ?? 0))).toBeLessThan(
					1,
				);
				expect(
					await page
						.locator(".catalog-controls")
						.evaluate((element) => element.scrollWidth <= element.clientWidth),
				).toBe(true);
			}
			expect(
				await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
			).toBe(true);
		});
	}

	test("repository dialog establishes, contains, and restores focus", async ({
		page,
		leitwerk: _leitwerk,
	}) => {
		await mockSkills(page);
		await page.goto("/skills");
		const trigger = page.getByRole("button", { name: "Repositories (1)" });
		await trigger.click();
		const dialog = page.getByRole("dialog", { name: "Configured repositories" });
		await expect(dialog).toBeVisible();
		await expect(page.getByRole("button", { name: "Close configured repositories" })).toBeFocused();
		await page.keyboard.press("Shift+Tab");
		expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
		await page.keyboard.press("Escape");
		await expect(dialog).toBeHidden();
		await expect(trigger).toBeFocused();
	});
});
