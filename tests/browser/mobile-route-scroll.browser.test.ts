import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import showcaseProcessesExtension from "@leitwerk-dev/showcase-processes";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";

test.use({
	isMobile: async ({ browserName }, use) => use(browserName === "chromium"),
	hasTouch: true,
	viewport: { width: 390, height: 500 },
	browserServerOptions: {
		tempPrefix: "leitwerk-mobile-route-scroll-browser-",
		configure: (config, tempRoot) => {
			config.process_configs = {
				poem_creator_process: {
					turn_configs: {},
					watchers: {
						create_poem: {
							enabled: true,
							poll_interval: "60s",
							file_path: `${tempRoot}/poem-trigger.txt`,
						},
					},
				},
			};
		},
		createExtensionCatalog: () => buildExtensionCatalogFromModules([showcaseProcessesExtension]),
	},
});

async function expectGestureToScrollPage(page: Page, surface: Locator) {
	const routeViewport = page.locator('[data-role="route-viewport"]');
	await expect(routeViewport).toHaveAttribute("data-mode", "page");
	await expect
		.poll(() => routeViewport.evaluate((element) => getComputedStyle(element).overflowY))
		.toBe("visible");
	await expect(surface).toBeVisible();
	await surface.scrollIntoViewIfNeeded();
	const box = await surface.boundingBox();
	if (!box) throw new Error("Expected a rendered scroll surface");

	const before = await page.evaluate(() => window.scrollY);
	const direction = await page.evaluate(() =>
		window.scrollY >= document.documentElement.scrollHeight - window.innerHeight - 50 ? -1 : 1,
	);
	if (page.context().browser()?.browserType().name() !== "chromium") {
		// Playwright exposes touch swipes only through Chromium's CDP API.
		await page.mouse.move(
			box.x + Math.min(box.width / 2, 180),
			Math.min(Math.max(box.y + 80, 84), 400),
		);
		await expect
			.poll(async () => {
				await page.mouse.wheel(0, direction * 300);
				return ((await page.evaluate(() => window.scrollY)) - before) * direction;
			})
			.toBeGreaterThan(10);
		return;
	}
	const client = await page.context().newCDPSession(page);
	const x = box.x + Math.min(box.width / 2, 180);
	const bottomY = Math.min(box.y + box.height - 24, 450);
	const topY = Math.max(box.y + 24, bottomY - 300, 84);
	const startY = direction === 1 ? bottomY : topY;
	const endY = direction === 1 ? topY : bottomY;
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

	await expect
		.poll(async () => ((await page.evaluate(() => window.scrollY)) - before) * direction)
		.toBeGreaterThan(10);
}

test("scrolls the process type selection on a mobile viewport", async ({ page, leitwerk }) => {
	void leitwerk;
	await page.goto("/");
	const launcherList = page.locator('[data-section="launcher-list"]');
	await expect.poll(() => launcherList.locator("li").count()).toBeGreaterThan(1);

	await expectGestureToScrollPage(page, launcherList);
});

test("scrolls launcher setup on a mobile viewport", async ({ page, leitwerk }) => {
	void leitwerk;
	await page.goto("/?launcher=single_prompt_process.single_prompt_ui");
	const launcherForm = page.locator('[data-section="launcher-form"]');
	await expect(launcherForm).toBeVisible();

	await expectGestureToScrollPage(page, launcherForm);
});

test("scrolls the watcher registry on a mobile viewport", async ({ page, leitwerk }) => {
	void leitwerk;
	await page.goto("/watchers");
	const watcherList = page.locator(".watcher-list");
	await expect(watcherList.locator("article")).toHaveCount(1);

	await expectGestureToScrollPage(page, watcherList);
});
