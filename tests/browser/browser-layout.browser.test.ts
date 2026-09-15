import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import showcaseProcessesExtension from "@leitwerk-dev/showcase-processes";
import { fixtureModelProviders } from "@leitwerk-dev/test-support";
import type { Locator } from "@playwright/test";
import { createAcceptedLlmTurn } from "../helpers/accepted-llm-turn.ts";
import { expect, test } from "./fixtures.js";

test.use({
	reducedMotion: "reduce",
	browserServerOptions: {
		tempPrefix: "leitwerk-browser-layout-",
		configure: (config) => {
			config.pi.model_profiles = [
				{
					id: "layout-reference-model-with-a-long-name",
					provider: "fixture",
					model_id: "fixture-model",
					thinking_level: "off",
				},
			];
		},
		createExtensionCatalog: () =>
			buildExtensionCatalogFromModules([
				{
					...showcaseProcessesExtension,
					modelProviders: fixtureModelProviders({
						id: "fixture",
						modelId: "fixture-model",
						piProvider: "openai",
					}),
				},
			]),
		useInProcessWorker: true,
	},
});

async function box(locator: Locator) {
	const bounds = await locator.boundingBox();
	if (!bounds) throw new Error("Expected a visible layout element");
	return bounds;
}

for (const viewport of [
	{ width: 1440, height: 900 },
	{ width: 1280, height: 800 },
	{ width: 1024, height: 768 },
	{ width: 390, height: 844 },
]) {
	test(`waiting composer preserves the Firefox layout at ${viewport.width}px`, async ({
		page,
		leitwerk,
	}, testInfo) => {
		await page.setViewportSize(viewport);
		const ctx = leitwerk.ctx;
		const process = ctx.deps.processes.create({
			processId: "poem_creator_process",
			selectedTurnId: "poem_review",
			lifecycleStatus: "waiting",
			title: "September skies and cloud craft",
		});
		const recordedAt = "2026-09-11T10:00:00.000Z";
		createAcceptedLlmTurn(
			ctx,
			{
				id: `trn_layout_${process.id}`,
				instanceId: process.id,
				turnId: "draft_poem",
				turnType: "llm",
				status: "succeeded",
				pathType: "primary",
				forkPiEntryId: null,
				resultPiEntryId: null,
				turnResultMarkdown: Array.from(
					{ length: 24 },
					(_, index) =>
						`## Verse ${index + 1}\n\nSeptember light fills the open windows.\n\nClouds drift across the sky.`,
				).join("\n\n"),
				errorSummary: null,
				startedAt: recordedAt,
				endedAt: recordedAt,
			},
			"browser-layout-digest",
		);
		await page.goto(`/processes/${process.id}`);
		await expect(page.locator('[data-section="leaf-outcome-actions"]')).toBeVisible();
		await page.evaluate(() => document.fonts.ready);
		const scroll = page.locator('[data-role="chronicle-scroll"]');
		await scroll.hover();
		await expect
			.poll(async () => {
				await page.mouse.wheel(0, -10_000);
				return scroll.evaluate((element) => element.scrollTop);
			})
			.toBe(0);
		const composer = page.getByRole("region", { name: "Choose the next action" });
		await expect(composer).toBeInViewport();
		const choice = composer.getByRole("combobox", { name: "Next action" });
		const feedback = composer.getByRole("textbox", { name: "Revision request" });
		const options = composer.getByRole("button", { name: "Options" });
		const send = composer.getByRole("button", { name: "Request revision", exact: true });
		const choiceBox = await box(choice);
		const optionsBox = await box(options);
		const sendBox = await box(send);
		expect(choiceBox.height).toBeCloseTo(48, 0);
		expect(Math.abs(choiceBox.y - optionsBox.y)).toBeLessThan(1);
		expect(optionsBox.height).toBeCloseTo(48, 0);
		expect(sendBox.height).toBeCloseTo(48, 0);
		const composerBox = await box(composer);
		const scrollBox = await box(scroll);
		expect(scrollBox.y + scrollBox.height).toBeLessThanOrEqual(composerBox.y + 1);
		for (const control of [choice, feedback, options, send]) {
			const bounds = await box(control);
			expect(bounds.x).toBeGreaterThanOrEqual(composerBox.x);
			expect(bounds.x + bounds.width).toBeLessThanOrEqual(composerBox.x + composerBox.width);
			await expect(control).toBeInViewport();
		}
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
		await testInfo.attach("waiting-composer", {
			body: await page.screenshot(),
			contentType: "image/png",
		});
		await feedback.fill("Keep the last verse.\nAdd a warmer ending.");
		await expect(feedback).toHaveValue("Keep the last verse.\nAdd a warmer ending.");
		await options.click();
		await expect(composer).not.toBeVisible();
		await expect(page.getByRole("textbox", { name: "Revision request" })).toHaveValue(
			"Keep the last verse.\nAdd a warmer ending.",
		);
		const model = page.getByRole("combobox", { name: "Next-turn model" });
		await expect(model).toBeVisible();
		const modelBox = await box(model);
		expect(modelBox.x + modelBox.width).toBeLessThanOrEqual(viewport.width);
		for (const name of ["Run now", "Run later"]) {
			const radioBox = await box(page.getByRole("radio", { name, exact: true }));
			expect(radioBox.width).toBe(14);
			expect(radioBox.height).toBe(14);
		}
		await page.getByRole("radio", { name: "Run later", exact: true }).check();
		await expect(page.getByRole("radio", { name: "Run later", exact: true })).toBeChecked();
		const hour = page.getByRole("combobox", { name: "Hour (24-hour)" });
		await hour.selectOption("14");
		await expect(hour).toHaveValue("14");
		await expect(page.getByRole("combobox", { name: "Minute", exact: true })).toBeVisible();
		await testInfo.attach("scheduled-action-form", {
			body: await page.screenshot(),
			contentType: "image/png",
		});
	});
}
