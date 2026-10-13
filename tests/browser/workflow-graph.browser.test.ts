import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import {
	automaticTurn,
	defineProcess,
	emptyParamsCodec,
	humanTurn,
	type LeitwerkExtensionModule,
	llmTurn,
} from "@leitwerk-dev/process-sdk";
import type { Locator, Page } from "@playwright/test";
import { type BrowserServer, expect, expectNoPageOverflow, test } from "./fixtures.js";

const definition = defineProcess({
	id: "workflow_browser",
	displayName: "Release readiness",
	paramsCodec: emptyParamsCodec,
	stateCodec: emptyParamsCodec,
	initialState: () => ({}),
	entry: "gather",
	turns: {
		gather: automaticTurn({
			description: "Gather release context",
			run: async () => ({ outcome: "ready", params: {} }),
			outcomes: { ready: { description: "Ready", parameters: {}, to: "assess" } },
		}),
		assess: llmTurn({
			description: "Assess component",
			availableTools: ["read"],
			askQuestions: true,
			resolveIntegrationTools: () => {
				throw new Error("Definition inspection must not resolve runtime tools");
			},
			branchType: "primary",
			context: "fresh",
			prompt: () => "Assess",
			outcomes: {
				submit_finding: { description: "Yield a finding for this component.", parameters: {} },
			},
			forEach: {
				items: () => {
					throw new Error("Definition inspection must not freeze runtime items");
				},
				itemCodec: emptyParamsCodec,
				resultCodec: emptyParamsCodec,
				key: () => "component",
				yields: { submit_finding: () => ({}) },
				collect: ({ state }) => state,
				routing: {
					kind: "branches",
					branches: { review: "review", ready: "publish" },
					choose: () => "ready",
				},
			},
		}),
		review: humanTurn({
			description: "Review recommendation",
			actions: {
				approve: { label: "Approve", acceptanceState: "neutral", to: "publish" },
				revise: { label: "Revise", acceptanceState: "neutral", to: "assess" },
			},
		}),
		publish: automaticTurn({
			description: "Publish release notes",
			run: async () => ({ outcome: "done", params: {} }),
			outcomes: { done: { description: "Published", parameters: {}, complete: true } },
		}),
	},
});
const extension: LeitwerkExtensionModule = {
	manifest: { id: "workflow-browser", version: "1.0.0" },
	setupCatalog(api) {
		api.registerProcess(definition);
	},
};
test.use({
	browserServerOptions: {
		tempPrefix: "leitwerk-workflow-browser-",
		createExtensionCatalog: () => buildExtensionCatalogFromModules([extension]),
	},
});

async function openWorkflow(page: Page, leitwerk: BrowserServer, width: number) {
	await page.setViewportSize({ width, height: 1000 });
	const process = leitwerk.ctx.deps.processes.create({
		processId: definition.id,
		title: "Release readiness",
		lifecycleStatus: "completed",
		selectedTurnId: null,
	});
	await page.goto(`/processes/${process.id}?inspect=process&section=workflow`);
	return page.getByRole("region", { name: "Workflow definition", exact: true });
}

async function repeatContinuation(graph: Locator, route: Locator, section: "entry" | "exit") {
	const id = await route.getAttribute("data-route-id");
	return graph.locator(`[data-route-id="${id}"][data-route-section="${section}"]`);
}

async function hoverRoute(page: Page, route: Locator, fraction = 0.7) {
	const path = route.locator(".route-hit");
	await path.scrollIntoViewIfNeeded();
	const point = await path.evaluate((element, position) => {
		const path = element as SVGPathElement;
		const point = path.getPointAtLength(path.getTotalLength() * position);
		const matrix = path.getScreenCTM();
		if (!matrix) throw new Error("Route is not rendered");
		const screen = point.matrixTransform(matrix);
		return { x: screen.x, y: screen.y };
	}, fraction);
	// Exercise the wider hit area, a few screen pixels away from the thin visible line.
	await page.mouse.move(point.x, point.y + 3);
}

for (const width of [1440, 390]) {
	test(`highlights exact routes across repeat boundaries at ${width}px`, async ({
		page,
		leitwerk,
	}) => {
		const graph = await openWorkflow(page, leitwerk, width);
		const publish = graph.getByRole("button", { name: "Publish release notes. Automation" });
		const ready = graph.locator('[data-flow-edge-from="assess"][data-flow-edge-to="publish"]');
		const review = graph.locator('[data-flow-edge-from="assess"][data-flow-edge-to="review"]');
		const readyExit = await repeatContinuation(graph, ready, "exit");
		const reviewExit = await repeatContinuation(graph, review, "exit");
		const loop = graph.locator('[data-route-section="loop"]');
		const results = graph.locator('[data-route-section="results"]');
		await expect(loop.locator(".route-line")).toHaveAttribute("stroke", "var(--graph-route)");
		await expect(loop.locator(".route-line")).toHaveAttribute("marker-end", /arrow-normal/);
		await publish.hover();
		await expect(ready).toHaveClass(/route-active/);
		await expect(readyExit).toHaveClass(/route-active/);
		await expect(
			graph.locator('[data-flow-edge-from="review"][data-flow-edge-to="publish"]'),
		).toHaveClass(/route-active/);
		await expect(review).not.toHaveClass(/route-active/);
		await expect(reviewExit).not.toHaveClass(/route-active/);
		await expect(loop).not.toHaveClass(/route-active/);
		await publish.click();
		const details = graph.getByRole("region", { name: "Details for Publish release notes" });
		await expect(details).toBeVisible();

		for (const segment of [ready, readyExit]) {
			await hoverRoute(page, segment);
			await expect(ready).toHaveClass(/route-active/);
			await expect(readyExit).toHaveClass(/route-active/);
			await expect(graph.locator(".route-active")).toHaveCount(2);
			await expect(graph.getByRole("tooltip")).toContainText(
				"Assess component → Publish release notes",
			);
			const tooltipBounds = await graph.getByRole("tooltip").boundingBox();
			const repeatBounds = await graph.locator(".repeat-group").boundingBox();
			if (!tooltipBounds || !repeatBounds) throw new Error("Missing tooltip or repeat enclosure");
			expect(
				tooltipBounds.y >= repeatBounds.y + repeatBounds.height ||
					tooltipBounds.y + tooltipBounds.height <= repeatBounds.y,
			).toBe(true);
			await expect(publish).toHaveClass(/chosen/);
			await expect(details).toBeVisible();
		}
		for (const segment of [loop, results]) {
			await hoverRoute(page, segment, 0.45);
			await expect(segment).toHaveClass(/route-active/);
			await expect(graph.locator(".route-active")).toHaveCount(1);
			await expect(segment.locator(".route-line")).toHaveAttribute("stroke", "var(--graph-accent)");
			await expect(segment.locator(".route-line")).toHaveAttribute("marker-end", /arrow-active/);
		}
		await page.mouse.move(0, 0);
		await ready.focus();
		await expect(ready).toBeFocused();
		await expect(readyExit).toHaveClass(/route-active/);
		await expect(graph.locator(".route-active")).toHaveCount(2);
		await page.keyboard.press("Enter");
		await expect(publish).toHaveClass(/chosen/);
		await expect(details).toBeVisible();
		await page.keyboard.press("Tab");
		await expect(ready).not.toBeFocused();

		const revise = graph.locator('[data-flow-edge-from="review"][data-flow-edge-to="assess"]');
		const reviseEntry = await repeatContinuation(graph, revise, "entry");
		await revise.focus();
		await expect(revise).toHaveClass(/route-active/);
		await expect(reviseEntry).toHaveClass(/route-active/);
		await expect(revise.locator(".route-line")).toHaveAttribute("stroke", "var(--graph-accent)");
		await expect(graph.locator(".route-active")).toHaveCount(2);
		const loopLabel = loop.locator(".route-label");
		await loopLabel.scrollIntoViewIfNeeded();
		// WebKit's automation bounding box omits the CSS scale for SVG text.
		const labelPoint = await loopLabel.evaluate((element) => {
			const rect = element.getBoundingClientRect();
			return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
		});
		await page.mouse.click(labelPoint.x, labelPoint.y);
		await expect(loop).toBeFocused();
		await expect(graph.locator(".route-active")).toHaveCount(1);
		await page.keyboard.press("Space");
		await expect(loop).toHaveClass(/route-active/);
		await expect(publish).toHaveClass(/chosen/);
		await expect(details).toBeVisible();
		await expectNoPageOverflow(page);
	});
	test(`dismisses tooltips after closing details at ${width}px`, async ({ page, leitwerk }) => {
		const graph = await openWorkflow(page, leitwerk, width);
		const publish = graph.getByRole("button", { name: "Publish release notes. Automation" });
		const activity = graph.getByRole("button", {
			name: "Assess component. LLM activity for one item.",
		});
		const review = graph.getByRole("button", { name: "Review recommendation. Operator decision" });
		const toolbar = graph.locator(".toolbar strong");
		const tooltip = graph.getByRole("tooltip");
		for (const closeWith of ["button", "Escape"]) {
			await publish.click();
			const details = graph.getByRole("region", { name: "Details for Publish release notes" });
			await expect(details).toBeVisible();
			if (closeWith === "button")
				await details.getByRole("button", { name: "Close step details" }).click();
			else {
				await toolbar.hover();
				await page.keyboard.press("Escape");
			}
			await expect(details).toHaveCount(0);
			await expect(publish).toBeFocused();
			await expect(tooltip).toHaveCount(0);
			await activity.hover();
			await expect(tooltip).toContainText("Assess component");
			await toolbar.hover();
			await expect(tooltip).toHaveCount(0);
			await expect(graph.locator(".highlighted, .route-active")).toHaveCount(0);

			await review.focus();
			await expect(review).toBeFocused();
			await expect(tooltip).toContainText("Review recommendation");
			await activity.hover();
			await expect(tooltip).toContainText("Assess component");
			await toolbar.hover();
			await expect(tooltip).toHaveCount(0);
		}
	});
	test(`inspects the shared workflow, tools and repeat targets at ${width}px`, async ({
		page,
		leitwerk,
	}, testInfo) => {
		const graph = await openWorkflow(page, leitwerk, width);
		const repeat = graph.getByRole("button", {
			name: "Repeat Assess component, one item at a time",
		});
		const activity = graph.getByRole("button", {
			name: "Assess component. LLM activity for one item.",
		});
		const collect = graph.getByRole("button", { name: "Collect results for Assess component" });
		await expect(graph).toBeVisible();
		await expect(
			graph.getByRole("button", { name: "Review recommendation. Operator decision" }),
		).toHaveCount(1);
		await repeat.scrollIntoViewIfNeeded();
		await repeat.locator(".repeat-title").hover();
		await expect(repeat).toHaveClass(/highlighted/);
		await activity.hover();
		await expect(activity).toHaveClass(/highlighted/);
		await expect(repeat).not.toHaveClass(/highlighted/);
		await collect.hover();
		await expect(collect).toHaveClass(/highlighted/);
		await expect(activity).not.toHaveClass(/highlighted/);
		await expect(collect).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
		const tooltip = graph.getByRole("tooltip");
		const enclosureBounds = await graph.locator(".repeat-group").boundingBox();
		const tooltipBounds = await tooltip.boundingBox();
		expect(enclosureBounds && tooltipBounds).toBeTruthy();
		if (enclosureBounds && tooltipBounds)
			expect(
				tooltipBounds.y >= enclosureBounds.y + enclosureBounds.height ||
					tooltipBounds.y + tooltipBounds.height <= enclosureBounds.y,
			).toBe(true);

		await collect.click();
		const collectionDetails = graph.getByRole("region", { name: "Details for Collect results" });
		await expect(collectionDetails).toContainText("even for an empty collection");
		await page.keyboard.press("Escape");
		await expect(collect).toBeFocused();
		await expect(collectionDetails).toHaveCount(0);
		await activity.click();
		const details = graph.getByRole("region", { name: "Details for Assess component" });
		const tool = details
			.locator("details")
			.filter({ has: page.locator("summary", { hasText: "submit_finding" }) });
		await expect(tool).not.toHaveAttribute("open");
		await expect(tool.locator("summary")).toHaveText("submit_finding");
		await tool.locator("summary").click();
		await expect(tool).toHaveAttribute("open", "");
		await expect(tool).toContainText("Finish item");
		await expect(tool).toContainText("Yield a finding for this component.");
		await expect(details).toContainText(
			"Additional integration tools are determined when this turn starts.",
		);
		await expectNoPageOverflow(page);
		const screenshot = testInfo.outputPath("workflow-tools.png");
		await page.screenshot({ path: screenshot });
		await testInfo.attach("workflow-tools", {
			path: screenshot,
			contentType: "image/png",
		});
		await details.getByRole("button", { name: "Open turn details" }).click();
		await expect(page).toHaveURL(/inspect=step&turnId=assess/);
		await expect(page.getByRole("heading", { name: "Purpose", exact: true })).toBeVisible();
		await expectNoPageOverflow(page);
	});
}
