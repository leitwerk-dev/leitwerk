// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import RouteLoadBoundary from "./RouteLoadBoundary.svelte";
import RouteLoadTestComponent from "./test-fixtures/RouteLoadTestComponent.svelte";

const mounted: Array<ReturnType<typeof mount>> = [];
const loadedRoute = { default: RouteLoadTestComponent };

afterEach(async () => {
	await Promise.all(mounted.splice(0).map((component) => unmount(component)));
	document.body.innerHTML = "";
});

describe("RouteLoadBoundary", () => {
	it("shows progress until a route chunk resolves", async () => {
		let resolveLoad: (value: typeof loadedRoute) => void = () => {};
		const load = new Promise<typeof loadedRoute>((resolve) => {
			resolveLoad = resolve;
		});
		mounted.push(
			mount(RouteLoadBoundary, {
				target: document.body,
				props: { load, props: { text: "Loaded route" } },
			}),
		);
		await tick();

		expect(document.querySelector('[role="status"]')?.textContent).toContain("Loading view");
		resolveLoad(loadedRoute);
		await tick();
		expect(document.body.textContent).toContain("Loaded route");
		expect(document.querySelector('[data-role="route-viewport"]')?.getAttribute("data-mode")).toBe(
			"page",
		);
	});

	it("keeps workspace routes in a contained viewport", async () => {
		mounted.push(
			mount(RouteLoadBoundary, {
				target: document.body,
				props: {
					load: Promise.resolve(loadedRoute),
					props: { text: "Workspace route" },
					viewportMode: "workspace",
				},
			}),
		);
		await tick();

		expect(document.querySelector('[data-role="route-viewport"]')?.getAttribute("data-mode")).toBe(
			"workspace",
		);
	});

	it("offers recovery when a route chunk rejects", async () => {
		const load = Promise.reject<typeof loadedRoute>(new Error("chunk unavailable"));
		mounted.push(
			mount(RouteLoadBoundary, {
				target: document.body,
				props: { load, props: { text: "Loaded route" } },
			}),
		);
		await tick();

		expect(document.querySelector('[role="alert"]')?.textContent).toContain(
			"This view couldn’t be loaded",
		);
		expect(document.querySelector("button")?.textContent).toContain("Reload application");
	});
});
