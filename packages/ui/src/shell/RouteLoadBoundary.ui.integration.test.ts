// @vitest-environment jsdom

import { tick } from "svelte";
import { describe, expect, it } from "vitest";
import { mountTest } from "../test-support/mount.js";
import RouteLoadBoundary from "./RouteLoadBoundary.svelte";
import RouteLoadTestComponent from "./test-fixtures/RouteLoadTestComponent.svelte";

const loadedRoute = { default: RouteLoadTestComponent };

describe("RouteLoadBoundary", () => {
	it("shows progress until a route chunk resolves", async () => {
		const { promise: load, resolve: resolveLoad } = Promise.withResolvers<typeof loadedRoute>();
		mountTest(RouteLoadBoundary, { load, props: { text: "Loaded route" } });
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
		mountTest(RouteLoadBoundary, {
			load: Promise.resolve(loadedRoute),
			props: { text: "Workspace route" },
			viewportMode: "workspace",
		});
		await tick();

		expect(document.querySelector('[data-role="route-viewport"]')?.getAttribute("data-mode")).toBe(
			"workspace",
		);
	});

	it("offers recovery when a route chunk rejects", async () => {
		const load = Promise.reject<typeof loadedRoute>(new Error("chunk unavailable"));
		mountTest(RouteLoadBoundary, { load, props: { text: "Loaded route" } });
		await tick();

		expect(document.querySelector('[role="alert"]')?.textContent).toContain(
			"This view couldn’t be loaded",
		);
		expect(document.querySelector("button")?.textContent).toContain("Reload application");
	});
});
