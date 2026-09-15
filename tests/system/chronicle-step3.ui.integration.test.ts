import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import singlePromptExtension from "@leitwerk-dev/showcase-processes";
import { describe, expect, it } from "vitest";
import { createAcceptedLlmTurn } from "../helpers/accepted-llm-turn.ts";
import {
	type MountedUiHarness,
	setupMountedUiHarness,
	teardownMountedUiHarness,
	waitFor,
} from "../helpers/ui-harness.ts";

const extensionCatalog = buildExtensionCatalogFromModules([singlePromptExtension]);

describe("chronicle step 3 leaf outcomes", () => {
	it("renders a durable selected-leaf snapshot in the chronicle", async () => {
		let harness: MountedUiHarness<Record<string, never>> | null = null;

		try {
			let instanceId = "";
			harness = await setupMountedUiHarness({
				extensionCatalog,
				route: () => `/processes/${instanceId}`,
				async prepare(testApp) {
					const process = testApp.ctx.deps.processes.create({
						processId: "single_prompt_process",
						selectedTurnId: null,
						lifecycleStatus: "completed",
						externalId: "CHRON-P3-1",
					});
					instanceId = process.id;

					createAcceptedLlmTurn(testApp.ctx, {
						id: "trn_snapshot",
						instanceId: process.id,
						turnId: "run_single_prompt",
						turnType: "llm",
						status: "succeeded",
						pathType: "primary",
						forkPiEntryId: null,
						resultPiEntryId: "assistant-snapshot",
						turnResultMarkdown: "## Final answer\n\nHello chronicle",
						errorSummary: null,
						startedAt: "2026-04-18T10:00:00.000Z",
						endedAt: "2026-04-18T10:00:04.000Z",
					});
					testApp.ctx.deps.events.create({
						instanceId: process.id,
						eventType: "turn_outcome_recorded",
						data: {
							turnRecordId: "trn_snapshot",
							turnId: "run_single_prompt",
							outcome: "completed",
							params: {},
						},
					});
					testApp.ctx.deps.leafOutcomeSnapshots.create({
						instanceId: process.id,
						leafEntryId: "assistant-snapshot",
						turnRecordId: "trn_snapshot",
						rendererId: "@leitwerk-dev/showcase-processes:single_prompt_process.leaf_outcome",
						schemaVersion: 1,
						props: { prompt: "Hello chronicle" },
						fallbackMarkdown: "## Final answer\n\nHello chronicle",
						status: "ready",
						anchoredAt: "2026-04-18T10:00:04.000Z",
					});
				},
			});

			await waitFor(() =>
				expect(
					document.querySelector('[data-section="leaf-outcome"][data-status="ready"]'),
				).not.toBeNull(),
			);
			await waitFor(() => expect(document.body.textContent).toContain("Final answer"));
			await waitFor(() => expect(document.body.textContent).toContain("Hello chronicle"));
			expect(document.querySelector('[data-section="leaf-outcome-placeholder"]')).toBeNull();
		} finally {
			await teardownMountedUiHarness(harness);
		}
	});

	it("renders a visible inline warning for capture_error snapshots", async () => {
		let harness: MountedUiHarness<Record<string, never>> | null = null;

		try {
			let instanceId = "";
			harness = await setupMountedUiHarness({
				extensionCatalog,
				route: () => `/processes/${instanceId}`,
				async prepare(testApp) {
					const process = testApp.ctx.deps.processes.create({
						processId: "single_prompt_process",
						selectedTurnId: null,
						lifecycleStatus: "completed",
						externalId: "CHRON-P3-2",
					});
					instanceId = process.id;

					createAcceptedLlmTurn(testApp.ctx, {
						id: "trn_warning",
						instanceId: process.id,
						turnId: "run_single_prompt",
						turnType: "llm",
						status: "succeeded",
						pathType: "primary",
						forkPiEntryId: null,
						resultPiEntryId: "assistant-warning",
						turnResultMarkdown: "## Fallback markdown",
						errorSummary: null,
						startedAt: "2026-04-18T11:00:00.000Z",
						endedAt: "2026-04-18T11:00:04.000Z",
					});
					testApp.ctx.deps.events.create({
						instanceId: process.id,
						eventType: "turn_outcome_recorded",
						data: {
							turnRecordId: "trn_warning",
							turnId: "run_single_prompt",
							outcome: "completed",
							params: {},
						},
					});
					testApp.ctx.deps.leafOutcomeSnapshots.create({
						instanceId: process.id,
						leafEntryId: "assistant-warning",
						turnRecordId: "trn_warning",
						rendererId: "@leitwerk-dev/showcase-processes:single_prompt_process.leaf_outcome",
						fallbackMarkdown: "## Fallback markdown",
						status: "capture_error",
						warningCode: "capture_exception",
						warningMessage: "Renderer capture exploded",
						anchoredAt: "2026-04-18T11:00:04.000Z",
					});
				},
			});

			await waitFor(() =>
				expect(
					document.querySelector('[data-section="leaf-outcome"][data-status="capture_error"]'),
				).not.toBeNull(),
			);
			await waitFor(() =>
				expect(document.body.textContent).toContain("Result preview unavailable"),
			);
			await waitFor(() => expect(document.body.textContent).toContain("Renderer capture exploded"));
			await waitFor(() => expect(document.body.textContent).toContain("Fallback markdown"));
		} finally {
			await teardownMountedUiHarness(harness);
		}
	});
});
