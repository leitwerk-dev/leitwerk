import path from "node:path";
import { buildFailedTurnRecoveryMetadata } from "@leitwerk-dev/domain";
import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import { createEmptyStructuralProcessState } from "@leitwerk-dev/process-sdk";
import type { AppContext } from "@leitwerk-dev/server";
import { writeProcessSessionSnapshot } from "@leitwerk-dev/server/testing";
import singlePromptExtension from "@leitwerk-dev/showcase-processes";
import { fixtureModelProviders } from "@leitwerk-dev/test-support";
import { createAcceptedLlmTurn } from "../helpers/accepted-llm-turn.ts";
import { expect, test } from "./fixtures.js";

let ctx: AppContext | null = null;
const continueRecoveryExtension = {
	...singlePromptExtension,
	modelProviders: fixtureModelProviders({
		id: "fixture",
		modelId: "fixture-model",
		piProvider: "openai",
	}),
};

async function seedRepeatContinueProcess() {
	if (!ctx) {
		throw new Error("Server context not initialized");
	}

	const state = createEmptyStructuralProcessState();
	state.semanticEntryRefs.rootEntry = { entryId: "root-user", turnRecordId: null };
	state.semanticEntryRefs.currentPrimaryPathLeaf = {
		entryId: "user-continue-1",
		turnRecordId: "trn_repeat_continue_1",
	};

	const process = ctx.deps.processes.create({
		processId: "single_prompt_process",
		selectedTurnId: "run_single_prompt",
		lifecycleStatus: "error",
		title: "Repeat continue browser test",
		externalId: "REPEAT-CONTINUE-001",
		metadata: buildFailedTurnRecoveryMetadata("trn_repeat_continue_1"),
		paramsJson: JSON.stringify({ prompt: "Say hello exactly once." }),
		stateJson: JSON.stringify(state),
	});
	const turn = createAcceptedLlmTurn(
		ctx,
		{
			id: "trn_repeat_continue_1",
			instanceId: process.id,
			turnId: "run_single_prompt",
			turnType: "llm",
			status: "failed",
			attemptNumber: 1,
			parentTurnRecordId: null,
			pathType: "primary",
			forkPiEntryId: "root-user",
			resultPiEntryId: "assistant-provider-error",
			modelProfileId: "test",
			turnResultMarkdown: null,
			errorSummary:
				"Turn 'run_single_prompt' continuation failed: transient provider issue after the first continue",
			errorClass: "llm_error",
			startedAt: "2026-05-01T12:00:00.000Z",
			endedAt: "2026-05-01T12:00:05.000Z",
		},
		"test-digest",
	);
	if (!turn.turnStartRecordId) throw new Error("Missing accepted turn start");
	ctx.deps.processes.update(process.id, {
		currentExecution: { kind: "worker_start", id: turn.turnStartRecordId },
	});

	await writeProcessSessionSnapshot(ctx, process.id, [
		{
			type: "session",
			version: 3,
			id: "sess_1",
			timestamp: "2026-05-01T11:59:59.000Z",
			cwd: "/tmp/repeat-continue-browser",
		},
		{
			type: "message",
			id: "root-user",
			parentId: null,
			timestamp: "2026-05-01T12:00:00.000Z",
			message: {
				role: "user",
				content: "Say hello exactly once.",
				timestamp: 1,
			},
		},
		{
			type: "message",
			id: "assistant-first-attempt",
			parentId: "root-user",
			timestamp: "2026-05-01T12:00:02.000Z",
			message: {
				role: "assistant",
				content: "Starting the response.",
				timestamp: 2,
			},
		},
		{
			type: "message",
			id: "user-continue-1",
			parentId: "assistant-first-attempt",
			timestamp: "2026-05-01T12:00:04.000Z",
			message: {
				role: "user",
				content: "continue",
				timestamp: 3,
			},
		},
		{
			type: "message",
			id: "assistant-provider-error",
			parentId: "user-continue-1",
			timestamp: "2026-05-01T12:00:05.000Z",
			message: {
				role: "assistant",
				content: [],
				stopReason: "error",
				errorMessage: "transient provider issue",
				timestamp: 4,
			},
		},
	]);

	return { process, failedTurnRecordId: "trn_repeat_continue_1" };
}

test.use({
	browserServerOptions: {
		tempPrefix: "leitwerk-browser-continue-recovery-",
		configure: (config, root) => {
			config.storage.sqlite_path = path.join(root, "storage.sqlite");
			config.storage.tree_files_dir = path.join(root, "trees");
			config.storage.process_workspaces_dir = path.join(root, "workspaces");
			config.pi.agent_dir = path.join(root, "pi-agent");
			config.pi.model_profiles = [
				{
					id: "test",
					provider: "fixture",
					model_id: "fixture-model",
					thinking_level: "off",
				},
			];
			config.workers.runner = "local";
		},
		createExtensionCatalog: () => buildExtensionCatalogFromModules([continueRecoveryExtension]),
		useInProcessWorker: true,
	},
});

test.beforeAll(async ({ leitwerk }) => {
	ctx = leitwerk.ctx;
});

test.describe("failed-turn continue recovery", () => {
	test("keeps Continue available when the latest saved progress already ends with a literal continue user message", async ({
		page,
	}) => {
		const { process, failedTurnRecordId } = await seedRepeatContinueProcess();
		const recoverySection = page.locator('[data-section="current-turn-recovery"]');
		const recoveryRailItem = page.locator(
			'[data-section="action-required-indicator"][data-rail-tone="error_recovery"]',
		);
		const continueButton = page.locator(
			`[data-action="continue-failed-turn"][data-turn-record-id="${failedTurnRecordId}"]`,
		);
		const unavailableNote = page.locator('[data-section="continue-unavailable"]');

		await page.goto(`/processes/${process.id}`);
		await page.waitForSelector('[data-page="process-detail"]');
		await page.setViewportSize({ width: 390, height: 844 });
		const failureToggle = page.getByRole("button", { name: "Collapse failed turn" });
		await expect(failureToggle).toBeVisible();
		const fitsHeader = await failureToggle.evaluate((button) => {
			const control = button.getBoundingClientRect();
			const slot = button.parentElement?.getBoundingClientRect();
			return !!slot && control.left >= slot.left - 1 && control.right <= slot.right + 1;
		});
		expect(fitsHeader).toBe(true);
		await failureToggle.click();
		await expect(page.getByRole("button", { name: "Expand failed turn" })).toBeVisible();
		await page.getByRole("button", { name: "Expand failed turn" }).click();
		await page.setViewportSize({ width: 1440, height: 900 });

		await expect(recoverySection).toBeVisible();
		await expect(recoveryRailItem).toBeVisible();
		await expect(recoveryRailItem).toContainText("Run Prompt");
		await expect(continueButton).toBeVisible();
		await expect(unavailableNote).toHaveCount(0);

		const continueResponsePromise = page.waitForResponse(
			(response) =>
				response
					.url()
					.includes(
						`/api/processes/${encodeURIComponent(process.id)}/turn-records/${encodeURIComponent(failedTurnRecordId)}/continue`,
					) && response.request().method() === "POST",
		);
		await continueButton.click();
		const continueResponse = await continueResponsePromise;
		expect(continueResponse.status()).toBe(200);
		await expect(page.locator('[data-section="continue-unavailable"]')).toHaveCount(0);
	});
});
