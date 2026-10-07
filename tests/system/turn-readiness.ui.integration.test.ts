import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import { emptyParamsCodec, flow, RetryableWaitError } from "@leitwerk-dev/process-sdk";
import { expect, it } from "vitest";
import {
	type MountedUiHarness,
	setupMountedUiHarness,
	teardownMountedUiHarness,
	waitFor,
} from "../helpers/ui-harness.ts";

it.each([
	"permanent",
	"transient",
] as const)("shows a %s readiness failure before any execution and offers the appropriate recovery", async (failure) => {
	let broken = true;
	const definition = flow
		.process("readiness_ui")
		.displayName("Readiness")
		.entry("work")
		.codecs({ params: emptyParamsCodec, state: emptyParamsCodec })
		.initialState(() => ({}))
		.turn(
			flow
				.automatic("work")
				.description("Publish the change")
				.waitFor(() => {
					if (broken) {
						if (failure === "transient") throw new RetryableWaitError("Provider unavailable");
						throw new Error("Invalid repository configuration");
					}
					return false;
				})
				.run(() => ({ outcome: "done" }))
				.outcome("done", (outcome) => outcome.description("Published").complete()),
		)
		.define();
	const extensionCatalog = buildExtensionCatalogFromModules([
		{
			manifest: { id: "readiness-ui", version: "0.1.0" },
			setupCatalog(api) {
				api.registerProcess(definition);
			},
		},
	]);
	let harness: MountedUiHarness<Record<string, never>> | null = null;
	let instanceId = "";
	try {
		harness = await setupMountedUiHarness({
			extensionCatalog,
			route: () => `/processes/${instanceId}`,
			async prepare(testApp) {
				const process = testApp.ctx.deps.processes.create({
					processId: definition.id,
					paramsJson: "{}",
					stateJson: "{}",
				});
				instanceId = process.id;
				await testApp.ctx.deps.processEngine.startProcess(instanceId, "work");
			},
		});
		if (failure === "permanent") {
			await waitFor(() =>
				expect(
					document.querySelector('[data-section="current-process-error"]')?.textContent,
				).toContain("Invalid repository configuration"),
			);
			const retry = document.querySelector<HTMLButtonElement>(
				'[data-action="retry-waiting-condition"]',
			);
			expect(retry).not.toBeNull();
			broken = false;
			retry?.click();
			await waitFor(() =>
				expect(document.querySelector('[data-section="turn-readiness"]')?.textContent).toContain(
					"This step will continue when its condition is met.",
				),
			);
			expect(document.querySelector('[data-section="current-process-error"]')).toBeNull();
		} else {
			await waitFor(() => {
				const status = document.querySelector('[data-section="turn-readiness"]');
				expect(status?.textContent).toContain("Provider unavailable");
				expect(status?.textContent).toContain("Next check:");
			});
			expect(document.querySelector('[data-action="retry-waiting-condition"]')).toBeNull();
		}
		expect(document.querySelector('[data-section="chronicle-empty-state"]')).toBeNull();
		const deps = harness.testApp.ctx.deps;
		expect(deps.processes.getById(instanceId)?.lifecycleStatus).toBe("waiting");
		expect(deps.turnStarts.listByInstance(instanceId)).toHaveLength(0);
		expect(deps.turnRecords.listByInstance(instanceId)).toHaveLength(0);
		expect(deps.leases.listByInstance(instanceId)).toHaveLength(0);
	} finally {
		await teardownMountedUiHarness(harness);
	}
});
