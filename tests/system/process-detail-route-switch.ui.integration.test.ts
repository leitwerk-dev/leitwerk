import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import singlePromptExtension from "@leitwerk-dev/showcase-processes";
import { describe, expect, it } from "vitest";
import {
	type MountedUiHarness,
	setupMountedUiHarness,
	teardownMountedUiHarness,
	waitFor,
} from "../helpers/ui-harness.ts";

const extensionCatalog = buildExtensionCatalogFromModules([singlePromptExtension]);

function navigateInPlace(path: string) {
	window.history.pushState(null, "", path);
	window.dispatchEvent(new PopStateEvent("popstate"));
}

describe("process detail route switching", () => {
	it("clears stale process detail state when switching from /processes/A to /processes/B", async () => {
		let harness: MountedUiHarness<Record<string, never>> | null = null;

		try {
			let firstInstanceId = "";
			let secondInstanceId = "";
			harness = await setupMountedUiHarness({
				extensionCatalog,
				route: () => `/processes/${firstInstanceId}`,
				async prepare(testApp) {
					const first = testApp.ctx.deps.processes.create({
						processId: "single_prompt_process",
						selectedTurnId: "run_single_prompt",
						lifecycleStatus: "active",
						externalId: "CHRON-A",
						modelProfileId: "model-a",
					});
					const second = testApp.ctx.deps.processes.create({
						processId: "single_prompt_process",
						selectedTurnId: "run_single_prompt",
						lifecycleStatus: "active",
						externalId: "CHRON-B",
						modelProfileId: "model-b",
					});
					firstInstanceId = first.id;
					secondInstanceId = second.id;
				},
			});

			await waitFor(() =>
				expect(document.querySelector('[data-page="process-detail"]')?.textContent).toContain(
					"Waiting for activity",
				),
			);
			harness.fetchHarness.failNext(`/api/processes/${secondInstanceId}/ui-snapshot`, 503);
			navigateInPlace(`/processes/${secondInstanceId}`);

			await waitFor(() => expect(window.location.pathname).toBe(`/processes/${secondInstanceId}`));
			await waitFor(() =>
				expect(document.body.textContent).toContain("Couldn't load this process"),
			);

			harness.testApp.ctx.deps.processes.update(firstInstanceId, {
				modelProfileId: "model-a-updated",
			});

			await waitFor(() =>
				expect(document.querySelector('[data-page="process-detail"]')?.textContent).not.toContain(
					"Waiting for activity",
				),
			);
			expect(document.querySelector('[data-page="process-detail"]')?.textContent).not.toContain(
				"Current path",
			);
			expect(document.querySelector('[data-page="process-detail"]')?.textContent).not.toContain(
				"model-a-updated",
			);
		} finally {
			await teardownMountedUiHarness(harness);
		}
	}, 20_000);
});
