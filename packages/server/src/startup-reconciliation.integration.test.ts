import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import {
	defineProcess,
	emptyParamsCodec,
	type LeitwerkExtensionModule,
	llmTurn,
} from "@leitwerk-dev/process-sdk";
import { fixtureModelProviders } from "@leitwerk-dev/test-support";
import {
	createPersistentIntegrationFixture,
	type IntegrationHarness,
	waitForValue as waitFor,
} from "@leitwerk-dev/test-support/integration";
import {
	createInProcessWorkerSpawn,
	StubPiTreeHandleFactory,
} from "@leitwerk-dev/test-support/worker-testing";
import { describe, expect, it, onTestFinished } from "vitest";
import type { AppOptions } from "./app.js";
import type { LeitwerkConfig } from "./config/index.js";
import { closeDatabase, createDatabase } from "./db/database.js";
import { createAllRepos } from "./db/repositories.js";
import { createAcceptedLlmTurnStart } from "./test-helpers/accepted-turn-start.js";

const startupPlanTurn = llmTurn<Record<string, never>, Record<string, never>>({
	description: "Startup planning turn",
	availableTools: [],
	completionMode: "turn_end",
	branchType: "primary",
	context: "fresh",
	prompt: async () => "Plan the work",
	turnEnd: { outcome: "completed", params: {}, complete: true },
});

const startupTestProcess = defineProcess<Record<string, never>, Record<string, never>>({
	id: "startup_test_process",
	displayName: "Startup Test Process",
	entry: "startup_plan_turn",
	turns: { startup_plan_turn: startupPlanTurn },
	paramsCodec: emptyParamsCodec,
	stateCodec: emptyParamsCodec,
	initialState() {
		return {};
	},
	worker(proc) {
		proc.start("startup_plan_turn");
		proc.turn("startup_plan_turn", async (run) => {
			await run.turn(startupPlanTurn);
		});
	},
});

const startupTestExtension: LeitwerkExtensionModule = {
	manifest: { id: "startup-test", version: "0.1.0" },
	modelProviders: fixtureModelProviders({
		id: "startup-provider",
		modelId: "fixture-model",
		piProvider: "ollama",
	}),
	setupCatalog(api) {
		api.registerProcess(startupTestProcess);
	},
};

const extensionCatalogPromise = buildExtensionCatalogFromModules([startupTestExtension]);

function createPersistentFixture(opts: { resumeOnBoot?: boolean } = {}) {
	const fixture = createPersistentIntegrationFixture("leitwerk-startup-", (config) => {
		config.workers.shutdown_grace_period = "100ms";
		config.workers.startup_timeout = "5s";
		config.workers.resume_on_boot = opts.resumeOnBoot ?? true;
		config.extension_loading.sources = [];
	});
	onTestFinished(fixture.dispose);
	return {
		...fixture,
		config: fixture.createConfig(),
		open: (config: LeitwerkConfig, appOverrides: Partial<AppOptions> = {}) =>
			fixture.open({
				config,
				listen: false,
				extensionCatalog: extensionCatalogPromise,
				appOverrides,
			}),
	};
}

function seedAcceptedWorkerTurn(
	harness: IntegrationHarness,
	input: { instanceId: string; turnRecordId: string; turnId: string; resourceDigest?: string },
): void {
	const startRecordId = `tsr_${input.turnRecordId}`;
	const lease = harness.ctx.deps.leases.create({
		instanceId: input.instanceId,
		workerId: `wkr_${input.turnRecordId}`,
		state: "bootstrapping",
	});
	harness.ctx.deps.leases.compareAndSetBootstrapReceipt(lease.id, {
		kind: "llm",
		startRecordId,
		workerLeaseId: lease.id,
		receiptEpoch: "startup-fixture",
		verifiedResourceSnapshotDigest: input.resourceDigest ?? "startup-fixture-digest",
		credentialRevision: 1,
		loadedResourceIds: [],
		resolvedModel: { providerId: "fixture-provider", modelId: "fixture-model" },
		preparedStart: {
			pathType: "primary",
			contextMode: "full",
			startTarget: { kind: "current_leaf" },
			forkPiEntryId: null,
		},
		readyAt: "2026-01-01T00:00:00.000Z",
	});
	harness.ctx.deps.leases.update(lease.id, { state: "exited" });
	createAcceptedLlmTurnStart(
		harness.ctx,
		{ id: input.turnRecordId, instanceId: input.instanceId, turnId: input.turnId },
		lease.id,
		{
			model: {
				profileId: "fixture-model",
				providerId: "fixture-provider",
				modelId: "fixture-model",
				thinkingLevel: "off",
			},
			piResourceSnapshotDigest: input.resourceDigest ?? "startup-fixture-digest",
		},
	);
	harness.ctx.deps.turnRecords.create({
		id: input.turnRecordId,
		instanceId: input.instanceId,
		turnId: input.turnId,
		turnType: "llm",
		status: "running",
		pathType: "primary",
		turnStartRecordId: startRecordId,
		acceptedWorkerLeaseId: lease.id,
	});
	harness.ctx.deps.processes.update(input.instanceId, {
		currentExecution: { kind: "worker_start", id: startRecordId },
	});
}

function configureStartupModel(config: LeitwerkConfig): void {
	config.pi.model_profiles = [
		{
			id: "startup-model",
			provider: "startup-provider",
			model_id: "fixture-model",
			thinking_level: "off",
		},
	];
}

describe("startup reconciliation", () => {
	it.each([
		7000, 10800,
	])("cancels a reserved start before connection (%i ms delay) without accepting a turn", async (connectMs) => {
		const { config, open, close } = createPersistentFixture();
		config.workers.startup_timeout = "30s";
		configureStartupModel(config);
		const harness = await open(config, {
			localWorkerSpawnImpl: createInProcessWorkerSpawn({
				extensionCatalog: extensionCatalogPromise,
				startupDelays: () => ({ connectMs, prepareMs: 1000 }),
			}),
		});
		await harness.ctx.listen({ host: "127.0.0.1", port: 0, useBoundAddressAsBaseUrl: true });
		const process = harness.ctx.deps.processes.create({
			defaultModelProfileId: "startup-model",
			processId: "startup_test_process",
			selectedTurnId: null,
			lifecycleStatus: "discovered",
		});
		expect(
			(await harness.ctx.deps.processEngine.startProcess(process.id, "startup_plan_turn")).ok,
		).toBe(true);
		const startup = async () => {
			const response = await harness.ctx.app.inject(`/api/processes/${process.id}/ui-snapshot`);
			expect(response.statusCode).toBe(200);
			return response.json().startup;
		};
		await waitFor(startup, (value) => value?.attempts?.[0]?.steps[1]?.status === "in_progress");
		expect(harness.ctx.deps.turnStarts.listByInstance(process.id)).toHaveLength(1);
		expect(harness.ctx.deps.turnRecords.listByInstance(process.id)).toHaveLength(0);
		const aborted = await harness.ctx.app.inject({
			method: "POST",
			url: `/api/processes/${process.id}/abort`,
		});
		expect(aborted.statusCode, aborted.body).toBe(200);
		expect(harness.ctx.deps.processes.getById(process.id)?.lifecycleStatus).toBe("aborted");
		expect(harness.ctx.deps.turnRecords.listByInstance(process.id)).toHaveLength(0);
		expect((await startup()).attempts[0].status).toBe("superseded");
		await close();
		const reopened = await open(config);
		expect(reopened.ctx.deps.turnRecords.listByInstance(process.id)).toHaveLength(0);
		expect(reopened.ctx.deps.processes.getById(process.id)?.lifecycleStatus).toBe("aborted");
	});

	it("persists successful delayed startup observations across a fresh app restart", async () => {
		const { config, open, close } = createPersistentFixture();
		configureStartupModel(config);
		const harness = await open(config, {
			localWorkerSpawnImpl: createInProcessWorkerSpawn({
				extensionCatalog: extensionCatalogPromise,
				piFactory: new StubPiTreeHandleFactory(),
				startupDelays: () => ({ connectMs: 50, prepareMs: 50 }),
			}),
		});
		await harness.ctx.listen({ host: "127.0.0.1", port: 0, useBoundAddressAsBaseUrl: true });
		const process = harness.ctx.deps.processes.create({
			defaultModelProfileId: "startup-model",
			processId: "startup_test_process",
			selectedTurnId: null,
			lifecycleStatus: "discovered",
		});
		expect(
			(await harness.ctx.deps.processEngine.startProcess(process.id, "startup_plan_turn")).ok,
		).toBe(true);
		await waitFor(
			() => harness.ctx.deps.processes.getById(process.id),
			(value) => value?.lifecycleStatus === "completed",
		);
		const response = await harness.ctx.app.inject(`/api/processes/${process.id}/ui-snapshot`);
		expect(response.statusCode).toBe(200);
		const attempts = response.json().startup.attempts;
		expect(attempts).toHaveLength(1);
		expect(attempts[0].status).toBe("succeeded");
		expect(attempts[0].steps.length).toBeGreaterThan(0);
		expect(attempts[0].steps.every((step: { status: string }) => step.status === "completed")).toBe(
			true,
		);
		const records = harness.ctx.deps.turnRecords.listByInstance(process.id);
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ status: "succeeded" });
		expect(harness.ctx.deps.turnStarts.listByInstance(process.id)[0].state.kind).toBe("accepted");
		await close();
		const reopened = await open(config);
		const restored = await reopened.ctx.app.inject(`/api/processes/${process.id}/ui-snapshot`);
		expect(restored.statusCode).toBe(200);
		expect(restored.json().startup.attempts).toEqual(attempts);
		expect(reopened.ctx.deps.turnRecords.listByInstance(process.id)).toEqual(records);
	});

	it("keeps process detail durable across restart when startup recovery parks in error", async () => {
		const { config, open, close } = createPersistentFixture();
		const firstHarness = await open(config);

		const created = firstHarness.ctx.deps.processes.create({
			processId: "startup_test_process",
			selectedTurnId: null,
			lifecycleStatus: "discovered",
		});
		const started = await firstHarness.ctx.deps.processEngine.startProcess(
			created.id,
			"startup_plan_turn",
		);
		expect(started.ok).toBe(true);
		await waitFor(
			() => firstHarness.ctx.deps.processes.getById(created.id),
			(value) => value?.currentExecution !== null,
		);

		expect(existsSync(config.storage.sqlite_path)).toBe(true);

		await close();

		const secondHarness = await open(config);
		const detailResponse = await secondHarness.ctx.app.inject({
			url: `/api/processes/${created.id}`,
		});
		expect(detailResponse.statusCode).toBe(200);
		const detail = await detailResponse.json();
		expect(detail.process).toMatchObject({
			id: created.id,
			processId: "startup_test_process",
			selectedTurnId: "startup_plan_turn",
		});

		await secondHarness.ctx.listen({ host: "127.0.0.1", port: 0, useBoundAddressAsBaseUrl: true });
		const reconciled = await waitFor(
			() => secondHarness.ctx.deps.processes.getById(created.id),
			(value) => value?.lifecycleStatus === "error",
		);
		expect(reconciled?.currentExecution?.kind).toBe("worker_start");
	});

	it("reclaims stale persisted leases before resuming active processes on boot", async () => {
		const { config, open, close } = createPersistentFixture();
		const firstHarness = await open(config);

		const process = firstHarness.ctx.deps.processes.create({
			processId: "startup_test_process",
			selectedTurnId: "startup_plan_turn",
			lifecycleStatus: "active",
		});
		mkdirSync(path.join(config.storage.process_workspaces_dir, process.id), { recursive: true });
		seedAcceptedWorkerTurn(firstHarness, {
			instanceId: process.id,
			turnRecordId: "trn_stale_startup",
			turnId: "startup_plan_turn",
		});

		await close();
		const offline = createDatabase({ sqlitePath: config.storage.sqlite_path });
		try {
			const leaseRepo = createAllRepos(offline).leases;
			const lease = leaseRepo
				.listByInstance(process.id)
				.find((lease) => lease.workerId === "wkr_trn_stale_startup");
			if (!lease) throw new Error("Expected seeded lease");
			leaseRepo.update(lease.id, { state: "busy", exitedAt: null });
			expect(leaseRepo.listActive().map((item) => item.id)).toContain(lease.id);
		} finally {
			closeDatabase(offline);
		}

		const secondHarness = await open(config);
		await secondHarness.ctx.listen({ host: "127.0.0.1", port: 0, useBoundAddressAsBaseUrl: true });

		expect(
			secondHarness.ctx.deps.leases
				.listActive()
				.find((lease) => lease.workerId === "wkr_trn_stale_startup"),
		).toBeUndefined();
		expect(
			secondHarness.ctx.deps.leases
				.listByInstance(process.id)
				.find((lease) => lease.workerId === "wkr_trn_stale_startup"),
		).toMatchObject({ state: "exited", exitedAt: expect.any(String) });
		const reconciled = await waitFor(
			() => secondHarness.ctx.deps.processes.getById(process.id),
			(value) => value?.lifecycleStatus === "error",
		);
		expect(reconciled?.currentExecution).toEqual({
			kind: "worker_start",
			id: "tsr_trn_stale_startup",
		});
	});

	it("reuses the persisted running turn record when startup resume restarts active work", async () => {
		const { config, open, close } = createPersistentFixture();
		const firstHarness = await open(config);

		const process = firstHarness.ctx.deps.processes.create({
			processId: "startup_test_process",
			selectedTurnId: "startup_plan_turn",
			lifecycleStatus: "active",
		});
		seedAcceptedWorkerTurn(firstHarness, {
			instanceId: process.id,
			turnRecordId: "trn_startup_running",
			turnId: "startup_plan_turn",
		});
		mkdirSync(path.join(config.storage.process_workspaces_dir, process.id), { recursive: true });

		await close();

		const secondHarness = await open(config);
		await secondHarness.ctx.listen({ host: "127.0.0.1", port: 0, useBoundAddressAsBaseUrl: true });

		const resumedTurn = await waitFor(
			() => secondHarness.ctx.deps.turnRecords.getById("trn_startup_running"),
			(turnRecord) => turnRecord?.status === "succeeded" || turnRecord?.status === "failed",
		);
		expect(resumedTurn?.status).toBe("failed");
		expect(
			secondHarness.ctx.deps.turnRecords
				.listByInstance(process.id)
				.map((turnRecord) => turnRecord.id),
		).toEqual(["trn_startup_running"]);
		expect(secondHarness.ctx.deps.processes.getById(process.id)).toMatchObject({
			id: process.id,
			currentExecution: { kind: "worker_start", id: "tsr_trn_startup_running" },
		});
		expect(secondHarness.ctx.deps.processes.getById(process.id)?.lifecycleStatus).toBe("error");
	});

	it("preserves saved active-leaf progress when a dead accepted worker cannot recover its resource bundle", async () => {
		const { config, open, close } = createPersistentFixture();
		const first = await open(config);
		const process = first.ctx.deps.processes.create({
			processId: "startup_test_process",
			selectedTurnId: "startup_plan_turn",
			lifecycleStatus: "active",
		});
		seedAcceptedWorkerTurn(first, {
			instanceId: process.id,
			turnRecordId: "trn_saved_progress",
			turnId: "startup_plan_turn",
			resourceDigest: "missing-saved-progress-bundle",
		});
		const stateJson = JSON.stringify({
			semanticEntryRefs: {
				rootEntry: { entryId: "root", turnRecordId: null },
				currentPrimaryPathLeaf: {
					entryId: "saved-active-leaf",
					turnRecordId: "trn_saved_progress",
				},
			},
		});
		first.ctx.deps.processes.update(process.id, { stateJson });
		mkdirSync(config.storage.tree_files_dir, { recursive: true });
		const treeFile = path.join(config.storage.tree_files_dir, `${process.id}.jsonl`);
		const savedTree = `${[
			{
				type: "session",
				version: 3,
				id: "saved-session",
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: "/tmp/saved-workspace",
			},
			{
				type: "message",
				id: "root",
				parentId: null,
				timestamp: "2026-01-01T00:00:01.000Z",
				message: { role: "user", content: "Preserve this request" },
			},
			{
				type: "message",
				id: "saved-active-leaf",
				parentId: "root",
				timestamp: "2026-01-01T00:00:02.000Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Saved partial progress" }],
				},
			},
		]
			.map((entry) => JSON.stringify(entry))
			.join("\n")}\n`;
		writeFileSync(treeFile, savedTree);
		expect(first.ctx.deps.turnRecords.getById("trn_saved_progress")?.status).toBe("running");
		await close();
		const second = await open(config);
		await second.ctx.listen({ host: "127.0.0.1", port: 0, useBoundAddressAsBaseUrl: true });
		const failed = await waitFor(
			() => second.ctx.deps.turnRecords.getById("trn_saved_progress"),
			(record) => record?.status === "failed",
		);
		expect(failed).toMatchObject({
			id: "trn_saved_progress",
			status: "failed",
			errorSummary: expect.stringMatching(/resource bundle.*unavailable/i),
		});
		expect(
			second.ctx.deps.turnRecords.listByInstance(process.id).map((record) => record.id),
		).toEqual(["trn_saved_progress"]);
		expect(second.ctx.deps.processes.getById(process.id)).toMatchObject({
			selectedTurnId: "startup_plan_turn",
			lifecycleStatus: "error",
			currentExecution: { kind: "worker_start", id: "tsr_trn_saved_progress" },
			stateJson,
		});
		expect(readFileSync(treeFile, "utf8")).toBe(savedTree);
	});

	it("preserves historical process and turn model selections when the catalog default changes", async () => {
		const { config: initialConfig, createConfig, open, close } = createPersistentFixture();
		const firstHarness = await open(initialConfig);

		const historicalTurnConfigsJson = JSON.stringify({
			startup_plan_turn: { modelProfileId: "claude_fast" },
		});
		const created = firstHarness.ctx.deps.processes.create({
			processId: "startup_test_process",
			selectedTurnId: "startup_plan_turn",
			lifecycleStatus: "active",
			defaultModelProfileId: "claude_fast",
			initialDefaultModelProfileId: "claude_fast",
			turnConfigsJson: historicalTurnConfigsJson,
			selectedTurnModelProfileId: "claude_fast",
		});

		await close();

		const updatedConfig = createConfig();
		updatedConfig.pi.model_profiles = updatedConfig.pi.model_profiles.filter(
			(profile) => profile.id === "local_qwen",
		);

		const secondHarness = await open(updatedConfig);

		const persisted = secondHarness.ctx.deps.processes.getById(created.id);
		expect(persisted).toMatchObject({
			id: created.id,
			lifecycleStatus: "active",
			defaultModelProfileId: "claude_fast",
			initialDefaultModelProfileId: "claude_fast",
			turnConfigsJson: historicalTurnConfigsJson,
			selectedTurnModelProfileId: "claude_fast",
			metadata: null,
		});
		expect(
			secondHarness.ctx.deps.events
				.listByInstance(created.id)
				.some((event) => event.eventType === "persisted_model_selection_repaired"),
		).toBe(false);

		await secondHarness.ctx.listen({ host: "127.0.0.1", port: 0, useBoundAddressAsBaseUrl: true });
		expect(secondHarness.ctx.deps.turnRecords.listByInstance(created.id)).toEqual([]);
		expect(secondHarness.ctx.deps.processes.getById(created.id)).toMatchObject({
			defaultModelProfileId: "claude_fast",
			turnConfigsJson: historicalTurnConfigsJson,
		});
	});

	it("preserves durable state without respawning workers when resume_on_boot is disabled", async () => {
		const { config, open, close } = createPersistentFixture({ resumeOnBoot: false });
		const firstHarness = await open(config);

		const process = firstHarness.ctx.deps.processes.create({
			processId: "startup_test_process",
			selectedTurnId: "startup_plan_turn",
			lifecycleStatus: "active",
		});
		mkdirSync(path.join(config.storage.process_workspaces_dir, process.id), { recursive: true });

		await close();

		const secondHarness = await open(config);
		await secondHarness.ctx.listen({ host: "127.0.0.1", port: 0, useBoundAddressAsBaseUrl: true });

		const detailResponse = await fetch(`${secondHarness.address}/api/processes/${process.id}`);
		expect(detailResponse.status).toBe(200);
		expect(secondHarness.ctx.deps.processes.getById(process.id)).toMatchObject({
			id: process.id,
			selectedTurnId: "startup_plan_turn",
			lifecycleStatus: "active",
		});
		expect(secondHarness.ctx.deps.leases.getByInstance(process.id)).toBeNull();
	});
});
