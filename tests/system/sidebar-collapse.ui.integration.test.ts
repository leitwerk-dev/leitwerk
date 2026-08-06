import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import showcaseProcessesExtension from "@leitwerk-dev/showcase-processes";
import { describe, expect, it } from "vitest";
import {
	type MountedUiHarness,
	setupMountedUiHarness,
	teardownMountedUiHarness,
	waitFor,
} from "../helpers/ui-harness.ts";

const extensionCatalog = buildExtensionCatalogFromModules([showcaseProcessesExtension]);

function click(element: Element | null) {
	element?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

describe("collapsed sidebar shell", () => {
	it("collapses to an icon rail and quick-switches current processes from the popover", async () => {
		let harness: MountedUiHarness<Record<string, never>> | null = null;
		let firstInstanceId = "";
		let secondInstanceId = "";
		const originalInnerWidth = window.innerWidth;

		Object.defineProperty(window, "innerWidth", {
			configurable: true,
			value: 1280,
		});

		try {
			harness = await setupMountedUiHarness({
				extensionCatalog,
				route: () => `/processes/${firstInstanceId}`,
				async prepare(testApp) {
					const first = testApp.ctx.deps.processes.create({
						processId: "single_prompt_process",
						selectedTurnId: "run_single_prompt",
						lifecycleStatus: "active",
						externalId: "RUN-101",
					});
					const second = testApp.ctx.deps.processes.create({
						processId: "single_prompt_process",
						selectedTurnId: "run_single_prompt",
						lifecycleStatus: "waiting",
						externalId: "RUN-102",
					});
					testApp.ctx.deps.processes.create({
						processId: "single_prompt_process",
						selectedTurnId: null,
						lifecycleStatus: "completed",
						externalId: "DONE-101",
					});
					firstInstanceId = first.id;
					secondInstanceId = second.id;
				},
			});

			window.dispatchEvent(new Event("resize"));

			await waitFor(() =>
				expect(document.querySelector('[data-sidebar-state="expanded"]')).not.toBeNull(),
			);
			await waitFor(() => expect(document.body.textContent).toContain("Leitwerk"));
			await waitFor(() => expect(document.body.textContent).toContain("RUN-101"));
			await waitFor(() => expect(document.body.textContent).toContain("RUN-102"));

			const collapseButton = await waitFor(() => {
				const element = document.querySelector('[data-action="toggle-sidebar"]');
				expect(element).not.toBeNull();
				return element as HTMLButtonElement;
			});
			click(collapseButton);

			await waitFor(() =>
				expect(document.querySelector('[data-sidebar-state="collapsed"]')).not.toBeNull(),
			);

			const currentProcessesButton = await waitFor(() => {
				const element = document.querySelector('[data-action="current-processes"]');
				expect(element).not.toBeNull();
				return element as HTMLButtonElement;
			});
			click(currentProcessesButton);

			const popover = await waitFor(() => {
				const element = document.querySelector('[data-section="current-processes-popover"]');
				expect(element).not.toBeNull();
				return element as HTMLElement;
			});

			expect(popover.textContent).toContain("Waiting and running");
			expect(popover.textContent).toContain("RUN-101");
			expect(popover.textContent).toContain("RUN-102");
			expect(popover.textContent).not.toContain("DONE-101");

			const selectedLink = popover.querySelector(`a[href="/processes/${firstInstanceId}"]`);
			expect(selectedLink?.getAttribute("aria-current")).toBe("page");

			const secondLink = popover.querySelector(`a[href="/processes/${secondInstanceId}"]`);
			expect(secondLink).not.toBeNull();
			click(secondLink);

			await waitFor(() => expect(window.location.pathname).toBe(`/processes/${secondInstanceId}`));
			await waitFor(() =>
				expect(document.querySelector('[data-section="current-processes-popover"]')).toBeNull(),
			);
		} finally {
			Object.defineProperty(window, "innerWidth", {
				configurable: true,
				value: originalInnerWidth,
			});
			window.dispatchEvent(new Event("resize"));
			await teardownMountedUiHarness(harness);
		}
	});
});
