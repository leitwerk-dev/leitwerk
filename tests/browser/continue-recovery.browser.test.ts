import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildFailedTurnRecoveryMetadata } from "@leitwerk-dev/domain";
import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import {
	builtinPiProvider,
	createEmptyStructuralProcessState,
	defineModelProvider,
	defineModelProviders,
} from "@leitwerk-dev/process-sdk";
import type { AppContext } from "@leitwerk-dev/server";
import singlePromptExtension from "@leitwerk-dev/showcase-processes";
import { expect, test } from "./fixtures.js";

let ctx: AppContext | null = null;
const continueRecoveryExtension = {
	...singlePromptExtension,
	modelProviders: defineModelProviders((rawConfig) => [
		{
			definition: defineModelProvider({
				id: "fixture",
				parseConfig: () => ({ config: {} }),
				worker: builtinPiProvider("openai"),
				models: () => [{ modelId: "fixture-model", availability: "available" }],
				secrets: () => ({}),
			}),
			rawConfig,
		},
	]),
};

async function writeTreeFile(
	treeFilesDir: string,
	instanceId: string,
	entries: readonly Record<string, unknown>[],
): Promise<void> {
	await mkdir(treeFilesDir, { recursive: true });
	await writeFile(
		path.join(treeFilesDir, `${instanceId}.jsonl`),
		`${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
		"utf8",
	);
}

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
	const lease = ctx.deps.leases.create({
		instanceId: process.id,
		workerId: "worker_repeat_continue_1",
		state: "exited",
	});
	ctx.deps.leases.update(lease.id, {
		state: "exited",
		exitedAt: "2026-05-01T12:00:05.000Z",
	});
	ctx.deps.turnStarts.create({
		id: "tsr_repeat_continue_1",
		instanceId: process.id,
		turnId: "run_single_prompt",
		turnType: "llm",
		proposedTurnRecordId: "trn_repeat_continue_1",
		startKind: "selected_turn",
		recoveryTurnRecordId: null,
		continuation: null,
		state: {
			kind: "accepted",
			start: {
				kind: "llm",
				model: { profileId: "test", providerId: "test", modelId: "test", thinkingLevel: "off" },
				providerOptions: {},
				providerWorkerConfig: null,
				piResourceSnapshotDigest: "test-digest",
				workerRuntimeProfileId: "test",
				piSettings: {},
			},
			turnRecordId: "trn_repeat_continue_1",
			acceptedWorkerLeaseId: lease.id,
		},
	});

	ctx.deps.turnRecords.create({
		id: "trn_repeat_continue_1",
		instanceId: process.id,
		turnId: "run_single_prompt",
		turnType: "llm",
		status: "failed",
		attemptNumber: 1,
		turnStartRecordId: "tsr_repeat_continue_1",
		acceptedWorkerLeaseId: lease.id,
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
	});
	ctx.deps.processes.update(process.id, {
		currentExecution: { kind: "worker_start", id: "tsr_repeat_continue_1" },
	});

	await writeTreeFile(ctx.config.storage.tree_files_dir, process.id, [
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

		await expect(recoverySection).toBeVisible();
		await expect(recoveryRailItem).toBeVisible();
		await expect(recoveryRailItem).toContainText("Run a single operator-provided prompt");
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
