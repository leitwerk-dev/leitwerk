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
type TestApp = NonNullable<MountedUiHarness<Record<string, never>>["testApp"]>;
type AcceptedLlmTurnFixtureInput = Parameters<
	TestApp["ctx"]["deps"]["turnRecords"]["create"]
>[0] & { id: string; turnType: "llm" };

function createAcceptedLlmTurn(testApp: TestApp, input: AcceptedLlmTurnFixtureInput) {
	const running = input.status === "running";
	const lease = testApp.ctx.deps.leases.create({
		instanceId: input.instanceId,
		workerId: `wkr_fixture_${input.id}`,
		state: running ? "busy" : "exited",
	});
	const start = testApp.ctx.deps.turnStarts.create({
		id: `tsr_fixture_${input.id}`,
		instanceId: input.instanceId,
		turnId: input.turnId,
		turnType: "llm",
		proposedTurnRecordId: input.id,
		startKind: "selected_turn",
		recoveryTurnRecordId: null,
		continuation: null,
		state: {
			kind: "accepted",
			start: {
				kind: "llm",
				model: {
					profileId: input.modelProfileId ?? "test",
					providerId: "test",
					modelId: "test",
					thinkingLevel: "off",
				},
				providerOptions: {},
				providerWorkerConfig: null,
				piResourceSnapshotDigest: "system-fixture-digest",
				workerRuntimeProfileId: "test",
				piSettings: {},
			},
			turnRecordId: input.id,
			acceptedWorkerLeaseId: lease.id,
		},
	});
	const turnRecord = testApp.ctx.deps.turnRecords.create({
		...input,
		turnStartRecordId: start.id,
		acceptedWorkerLeaseId: lease.id,
	});
	if (running) {
		testApp.ctx.deps.processes.update(input.instanceId, {
			currentExecution: { kind: "worker_start", id: start.id },
		});
	} else {
		testApp.ctx.deps.leases.update(lease.id, {
			exitedAt: input.endedAt ?? input.startedAt ?? new Date().toISOString(),
		});
	}
	return turnRecord;
}

describe("chronicle step 1 shell", () => {
	it("renders the home process gallery at root and opens launcher setup", async () => {
		let harness: MountedUiHarness<Record<string, never>> | null = null;

		try {
			harness = await setupMountedUiHarness({
				extensionCatalog,
				route: "/",
			});

			await waitFor(() => expect(document.querySelector('[data-shell="app"]')).not.toBeNull());
			await waitFor(() => expect(document.querySelector('[data-shell="app"]')).not.toBeNull());
			await waitFor(() => expect(document.querySelector('[data-page="home"]')).not.toBeNull());
			await waitFor(() => expect(document.querySelector('[data-column="sidebar"]')).not.toBeNull());
			await waitFor(() =>
				expect(document.querySelector('[data-section="process-gallery"]')).not.toBeNull(),
			);
			await waitFor(() =>
				expect(document.querySelector('[data-action="create-process"]')).not.toBeNull(),
			);
			await waitFor(() =>
				expect(document.querySelector('[data-section="launcher-list"]')).not.toBeNull(),
			);
			await waitFor(() =>
				expect(
					document.querySelector('[data-section="launcher-list"] [data-launcher-id]'),
				).not.toBeNull(),
			);
			expect(document.querySelector('[data-section="launcher-form"]')).toBeNull();

			const launcherButton = document.querySelector<HTMLButtonElement>(
				'[data-section="launcher-list"] [data-launcher-id]',
			);
			expect(launcherButton).not.toBeNull();
			launcherButton?.click();
			await waitFor(() =>
				expect(document.querySelector('[data-section="process-configure"]')).not.toBeNull(),
			);
			await waitFor(() =>
				expect(document.querySelector('[data-section="launcher-form"]')).not.toBeNull(),
			);
		} finally {
			await teardownMountedUiHarness(harness);
		}
	});

	it("renders the new process shell and shows a live tail when a turn is in progress", async () => {
		let harness: MountedUiHarness<Record<string, never>> | null = null;

		try {
			let instanceId = "";
			harness = await setupMountedUiHarness({
				extensionCatalog,
				route: () => `/processes/${instanceId}`,
				async prepare(testApp) {
					const process = testApp.ctx.deps.processes.create({
						processId: "single_prompt_process",
						selectedTurnId: "run_single_prompt",
						lifecycleStatus: "active",
						externalId: "CHRON-101",
					});
					instanceId = process.id;

					createAcceptedLlmTurn(testApp, {
						id: "trn_live_1",
						instanceId: process.id,
						turnId: "run_single_prompt",
						turnType: "llm",
						status: "running",
						pathType: "primary",
						forkPiEntryId: null,
						resultPiEntryId: null,
						turnResultMarkdown: null,
						errorSummary: null,
						startedAt: "2026-04-18T10:00:00.000Z",
						endedAt: null,
					});
				},
			});

			await waitFor(() => expect(document.querySelector('[data-shell="app"]')).not.toBeNull());
			await waitFor(() =>
				expect(document.querySelector('[data-page="process-detail"]')).not.toBeNull(),
			);
			await waitFor(() =>
				expect(
					document.querySelector(
						'[data-section="turn-rail-list"] [data-turn-id="run_single_prompt"][data-turn-status="in_progress"]',
					),
				).not.toBeNull(),
			);
			await waitFor(() =>
				expect(
					document.querySelector('[data-section="live-tail"][data-turn-id="run_single_prompt"]'),
				).not.toBeNull(),
			);
		} finally {
			await teardownMountedUiHarness(harness);
		}
	});
});
