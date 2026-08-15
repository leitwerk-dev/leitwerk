import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import showcaseProcessesExtension from "@leitwerk-dev/showcase-processes";
import { devices, type Locator, type Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";

test.use({
	...devices["Pixel 5"],
	viewport: { width: 390, height: 500 },
	browserServerOptions: {
		tempPrefix: "leitwerk-mobile-home-scroll-browser-",
		createExtensionCatalog: () => buildExtensionCatalogFromModules([showcaseProcessesExtension]),
	},
});

async function expectTouchSwipeToScroll(page: Page, surface: Locator) {
	await expect(surface).toBeVisible();
	await surface.scrollIntoViewIfNeeded();
	const box = await surface.boundingBox();
	if (!box) throw new Error("Expected a rendered scroll surface");

	const before = await page.evaluate(() => window.scrollY);
	const client = await page.context().newCDPSession(page);
	const x = box.x + Math.min(box.width / 2, 180);
	const startY = Math.min(box.y + box.height - 24, 450);
	const endY = Math.max(box.y + 24, startY - 300);
	await client.send("Input.dispatchTouchEvent", {
		type: "touchStart",
		touchPoints: [{ x, y: startY }],
	});
	for (let step = 1; step <= 5; step += 1) {
		await client.send("Input.dispatchTouchEvent", {
			type: "touchMove",
			touchPoints: [{ x, y: startY + ((endY - startY) * step) / 5 }],
		});
	}
	await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
	await client.detach();

	await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(before);
}

test("scrolls the process type selection on a mobile viewport", async ({ page, leitwerk }) => {
	void leitwerk;
	await page.goto("/");
	const launcherList = page.locator('[data-section="launcher-list"]');
	await expect.poll(() => launcherList.locator("li").count()).toBeGreaterThan(1);

	await expectTouchSwipeToScroll(page, launcherList);
});

test("scrolls launcher setup on a mobile viewport", async ({ page, leitwerk }) => {
	void leitwerk;
	await page.goto("/?launcher=single_prompt_process.single_prompt_ui");
	const launcherForm = page.locator('[data-section="launcher-form"]');
	await expect(launcherForm).toBeVisible();

	await expectTouchSwipeToScroll(page, launcherForm);
});
