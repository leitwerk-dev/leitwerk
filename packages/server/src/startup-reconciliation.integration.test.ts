import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import {
	type Codec,
	defineProcess,
	type LeitwerkExtensionModule,
	llmTurn,
} from "@leitwerk-dev/process-sdk";
import {
	createIntegrationHarness,
	type IntegrationHarness,
} from "@leitwerk-dev/test-support/integration";
import {
	createInProcessWorkerSpawn,
	type StubPiTreeHandle,
	StubPiTreeHandleFactory,
} from "@leitwerk-dev/test-support/worker-testing";
import { afterEach, describe, expect, it } from "vitest";
import type { AppOptions } from "./app.js";
import { getDefaultConfig, type LeitwerkConfig } from "./config/index.js";

const emptyCodec: Codec<Record<string, never>> = {
	parse() {
		return {};
	},
	serialize(value) {
		return value;
	},
};

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
	paramsCodec: emptyCodec,
	stateCodec: emptyCodec,
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
	setupCatalog(api) {
		api.registerProcess(startupTestProcess);
	},
};

const extensionCatalogPromise = buildExtensionCatalogFromModules([startupTestExtension]);

const harnesses: IntegrationHarness[] = [];
const tempRoots: string[] = [];

async function waitFor<T>(
	read: () => T,
	predicate: (value: T) => boolean,
	timeoutMs = 5_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (true) {
		const value = read();
		if (predicate(value)) {
			return value;
		}
		if (Date.now() >= deadline) {
			throw new Error("timed out waiting for startup reconciliation condition");
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

function createPersistentConfig(
	tempRoot: string,
	opts: { resumeOnBoot?: boolean } = {},
): LeitwerkConfig {
	const config = getDefaultConfig();
	config.storage.sqlite_path = path.join(tempRoot, "db", "leitwerk.sqlite");
	config.storage.process_workspaces_dir = path.join(tempRoot, "workspaces");
	config.storage.tree_files_dir = path.join(tempRoot, "trees");
	config.workers.shutdown_grace_period = "100ms";
	config.workers.startup_timeout = "5s";
	config.workers.resume_on_boot = opts.resumeOnBoot ?? true;
	config.extension_loading.sources = [];
	return config;
}

async function createPersistentHarness(
	config: LeitwerkConfig,
	appOverrides: Partial<AppOptions> = {},
): Promise<IntegrationHarness> {
	const harness = await createIntegrationHarness({
		config,
		extensionCatalog: extensionCatalogPromise,
		inProcessWorkers: !appOverrides.localWorkerSpawnImpl,
		appOverrides,
	});
	harnesses.push(harness);
	return harness;
}

async function closeHarness(harness: IntegrationHarness): Promise<void> {
	const index = harnesses.indexOf(harness);
	if (index >= 0) {
		harnesses.splice(index, 1);
	}
	await harness.ctx.app.close();
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
	harness.ctx.deps.turnStarts.create({
		id: startRecordId,
		instanceId: input.instanceId,
		turnId: input.turnId,
		turnType: "llm",
		proposedTurnRecordId: input.turnRecordId,
		startKind: "selected_turn",
		recoveryTurnRecordId: null,
		continuation: null,
		state: {
			kind: "accepted",
			start: {
				kind: "llm",
				model: {
					profileId: "fixture-model",
					providerId: "fixture-provider",
					modelId: "fixture-model",
					thinkingLevel: "off",
				},
				providerOptions: {},
				providerWorkerConfig: null,
				piResourceSnapshotDigest: input.resourceDigest ?? "startup-fixture-digest",
				workerRuntimeProfileId: "local",
				piSettings: {},
			},
			turnRecordId: input.turnRecordId,
			acceptedWorkerLeaseId: lease.id,
		},
	});
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

afterEach(async () => {
	while (harnesses.length > 0) {
		const harness = harnesses.pop();
		await harness?.ctx.app.close();
	}
	while (tempRoots.length > 0) {
		const tempRoot = tempRoots.pop();
		if (tempRoot) {
			rmSync(tempRoot, { recursive: true, force: true });
		}
	}
});

describe("startup reconciliation", () => {
	it("keeps process detail durable across restart and auto-resumes active work on boot", async () => {
		const tempRoot = mkdtempSync(path.join(tmpdir(), "leitwerk-startup-"));
		tempRoots.push(tempRoot);
		const config = createPersistentConfig(tempRoot);
		const firstHarness = await createPersistentHarness(config);

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

		await closeHarness(firstHarness);

		const secondHarness = await createPersistentHarness(config);
		const detailResponse = await fetch(`${secondHarness.address}/api/processes/${created.id}`);
		expect(detailResponse.status).toBe(200);
		const detail = await detailResponse.json();
		expect(detail.process).toMatchObject({
			id: created.id,
			processId: "startup_test_process",
			selectedTurnId: "startup_plan_turn",
		});

		await secondHarness.ctx.startBackgroundServices();
		const reconciled = await waitFor(
			() => secondHarness.ctx.deps.processes.getById(created.id),
			(value) => value?.lifecycleStatus === "error",
		);
		expect(reconciled?.currentExecution?.kind).toBe("worker_start");
	});

	it("reclaims stale persisted leases before resuming active processes on boot", async () => {
		const tempRoot = mkdtempSync(path.join(tmpdir(), "leitwerk-startup-"));
		tempRoots.push(tempRoot);
		const config = createPersistentConfig(tempRoot);
		const firstHarness = await createPersistentHarness(config);

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

		await closeHarness(firstHarness);

		const secondHarness = await createPersistentHarness(config);
		await secondHarness.ctx.startBackgroundServices();

		expect(
			secondHarness.ctx.deps.leases
				.listActive()
				.find((lease) => lease.workerId === "wkr_trn_stale_startup"),
		).toBeUndefined();
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
		const tempRoot = mkdtempSync(path.join(tmpdir(), "leitwerk-startup-"));
		tempRoots.push(tempRoot);
		const config = createPersistentConfig(tempRoot);
		const firstHarness = await createPersistentHarness(config);

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

		await closeHarness(firstHarness);

		const secondHarness = await createPersistentHarness(config);
		await secondHarness.ctx.startBackgroundServices();

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

	it.skip("keeps the persisted active leaf when startup resume continues a running turn", async () => {
		const tempRoot = mkdtempSync(path.join(tmpdir(), "leitwerk-startup-"));
		tempRoots.push(tempRoot);
		const config = createPersistentConfig(tempRoot);
		const sharedPiFactory = new StubPiTreeHandleFactory();
		const sharedSpawnImpl = createInProcessWorkerSpawn({
			extensionCatalog: extensionCatalogPromise,
			piFactory: sharedPiFactory,
		});
		const firstHarness = await createPersistentHarness(config, {
			localWorkerSpawnImpl: sharedSpawnImpl,
		});

		const process = firstHarness.ctx.deps.processes.create({
			processId: "startup_test_process",
			selectedTurnId: "startup_plan_turn",
			lifecycleStatus: "active",
		});
		const workspaceRoot = path.join(config.storage.process_workspaces_dir, process.id);
		const treeFile = path.join(config.storage.tree_files_dir, `${process.id}.jsonl`);
		mkdirSync(workspaceRoot, { recursive: true });
		const seededHandle = (await sharedPiFactory.createPrimaryTreeHandle({
			instanceId: process.id,
			treeFile,
			workspaceRoot,
			resume: false,
		})) as StubPiTreeHandle;
		await seededHandle.prompt("Seed previous completed turn");
		const previousLeafId = seededHandle.getLeafId();
		await seededHandle.prompt("Seed active turn kickoff");
		const activeLeafId = seededHandle.getLeafId();
		const rootEntryId = previousLeafId
			? (seededHandle.getBranch(previousLeafId)[0]?.id ?? null)
			: null;
		if (!previousLeafId || !activeLeafId || !rootEntryId) {
			throw new Error("expected seeded tree entries for startup resume test");
		}
		await seededHandle.close();

		firstHarness.ctx.deps.turnRecords.create({
			id: "trn_startup_previous_leaf",
			instanceId: process.id,
			turnId: "startup_plan_turn",
			status: "succeeded",
			pathType: "primary",
			resultPiEntryId: previousLeafId,
		});
		seedAcceptedWorkerTurn(firstHarness, {
			instanceId: process.id,
			turnRecordId: "trn_startup_running_leaf",
			turnId: "startup_plan_turn",
		});
		firstHarness.ctx.deps.processes.update(process.id, {
			stateJson: JSON.stringify({
				semanticEntryRefs: {
					rootEntry: { entryId: rootEntryId, turnRecordId: null },
					currentPrimaryPathLeaf: {
						entryId: previousLeafId,
						turnRecordId: "trn_startup_previous_leaf",
					},
				},
			}),
		});

		await closeHarness(firstHarness);

		const secondHarness = await createPersistentHarness(config, {
			localWorkerSpawnImpl: sharedSpawnImpl,
		});
		await secondHarness.ctx.startBackgroundServices();

		const resumedTurn = await waitFor(
			() => secondHarness.ctx.deps.turnRecords.getById("trn_startup_running_leaf"),
			(turnRecord) => turnRecord?.status === "succeeded" || turnRecord?.status === "failed",
		);
		expect(resumedTurn?.status).toBe("succeeded");
		expect(
			secondHarness.ctx.deps.turnRecords
				.listByInstance(process.id)
				.map((turnRecord) => turnRecord.id)
				.sort(),
		).toEqual(["trn_startup_previous_leaf", "trn_startup_running_leaf"]);
		expect(secondHarness.ctx.deps.processes.getById(process.id)).toMatchObject({
			id: process.id,
			currentExecution: null,
		});
		expect(secondHarness.ctx.deps.processes.getById(process.id)?.lifecycleStatus).not.toBe("error");

		const resumedHandle = sharedPiFactory.sessions.at(-1);
		expect(resumedHandle?.isResumed).toBe(true);
		expect(resumedHandle?.prompts).toEqual([]);
		expect(resumedHandle?.getLeafId()).toBe("turn-4");
		expect(
			resumedHandle?.getBranch(resumedHandle.getLeafId() ?? undefined).map((entry) => entry.id),
		).toEqual(["user-1", "turn-1", "user-2", "turn-2", "user-3", "turn-4"]);
		expect(resumedHandle?.getBranch(activeLeafId).map((entry) => entry.id)).toEqual([
			"user-1",
			"turn-1",
			"user-2",
			"turn-2",
		]);
	});

	it("uses the current default without rewriting historical process or turn models", async () => {
		const tempRoot = mkdtempSync(path.join(tmpdir(), "leitwerk-startup-"));
		tempRoots.push(tempRoot);
		const initialConfig = createPersistentConfig(tempRoot);
		const firstHarness = await createPersistentHarness(initialConfig);

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

		await closeHarness(firstHarness);

		const updatedConfig = createPersistentConfig(tempRoot);
		updatedConfig.pi.model_profiles = updatedConfig.pi.model_profiles.filter(
			(profile) => profile.id === "local_qwen",
		);

		const secondHarness = await createPersistentHarness(updatedConfig);

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

		await secondHarness.ctx.startBackgroundServices();
		expect(secondHarness.ctx.deps.turnRecords.listByInstance(created.id)).toEqual([]);
		expect(secondHarness.ctx.deps.processes.getById(created.id)).toMatchObject({
			defaultModelProfileId: "claude_fast",
			turnConfigsJson: historicalTurnConfigsJson,
		});
	});

	it("preserves durable state without respawning workers when resume_on_boot is disabled", async () => {
		const tempRoot = mkdtempSync(path.join(tmpdir(), "leitwerk-startup-"));
		tempRoots.push(tempRoot);
		const config = createPersistentConfig(tempRoot, { resumeOnBoot: false });
		const firstHarness = await createPersistentHarness(config);

		const process = firstHarness.ctx.deps.processes.create({
			processId: "startup_test_process",
			selectedTurnId: "startup_plan_turn",
			lifecycleStatus: "active",
		});
		mkdirSync(path.join(config.storage.process_workspaces_dir, process.id), { recursive: true });

		await closeHarness(firstHarness);

		const secondHarness = await createPersistentHarness(config);
		await secondHarness.ctx.startBackgroundServices();

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
