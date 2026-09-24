import { describe, expect, it, vi } from "vitest";
import { getDefaultConfig } from "../config/index.js";
import {
	createPiResourceBundleCache,
	createPiResourceBundlePinReconciler,
} from "../pi-resources/index.js";
import { buildProcessActionRegistry } from "../process-action-registry.js";
import { createFakeWorkerSupervisor } from "../test-helpers/fake-worker-supervisor.js";
import { createOwnedTestDeps as createTestDeps } from "../test-helpers/owned-test-deps.js";
import {
	createFixtureProcess,
	createProcessGraphRegistry,
} from "../test-helpers/process-fixtures.js";
import { createTestTurnStart } from "../test-helpers/process-model-fixtures.js";
import { createTestLlmTurn } from "../test-helpers/turn-fixtures.js";
import { createSelectedTurnStart } from "../test-helpers/unit-deps.js";
import { reconcileProcessesOnStartup } from "./startup-reconciliation.js";

describe("reconcileProcessesOnStartup", () => {
	it("resumes an isolated LLM start from its volume when the server bundle cache is empty", async () => {
		const deps = createTestDeps();
		const processDef = createFixtureProcess({
			id: "startup_missing_bundle_process",
			entry: "llm_turn",
			turns: { llm_turn: createTestLlmTurn("llm_turn", {}) },
		});
		const processGraphs = createProcessGraphRegistry([processDef]);
		const processActionRegistry = buildProcessActionRegistry({ processes: processGraphs });
		const process = deps.processes.create({
			processId: processDef.id,
			selectedTurnId: "llm_turn",
			lifecycleStatus: "active",
		});
		createSelectedTurnStart(deps, {
			instanceId: process.id,
			turnId: "llm_turn",
			turnType: "llm",
			proposedTurnRecordId: "trn_missing_bundle",
			state: {
				kind: "starting",
				start: {
					kind: "llm",
					model: { profileId: "m", providerId: "p", modelId: "m", thinkingLevel: "off" },
					providerOptions: {},
					providerWorkerConfig: null,
					piResourceSnapshotDigest: "missing",
					workerRuntimeProfileId: "local",
					piSettings: {},
				},
			},
		});
		const supervisor = createFakeWorkerSupervisor();
		const config = getDefaultConfig();
		config.workers.runner = "docker";
		const recordWorkerFailure = vi.fn();

		await reconcileProcessesOnStartup({
			config,
			processes: deps.processes,
			leases: deps.leases,
			turnStarts: deps.turnStarts,
			turnRecords: deps.turnRecords,
			broadcaster: deps.broadcaster,
			supervisor,
			commands: { recordWorkerFailure },
			bundlePins: createPiResourceBundlePinReconciler({
				turnStarts: deps.turnStarts,
				turnRecords: deps.turnRecords,
				bundleCache: createPiResourceBundleCache(),
			}),
			processActionRegistry,
		});

		expect(deps.processes.getById(process.id)?.lifecycleStatus).toBe("active");
		expect(supervisor.spawnCalls).toEqual([process.id]);
		expect(recordWorkerFailure).not.toHaveBeenCalled();
	});

	it("reclaims stale leases and resumes active processes without an adopted worker", async () => {
		const deps = createTestDeps();
		const processDef = createFixtureProcess({
			id: "startup_resume_process",
			entry: "llm_turn",
			turns: {},
		});
		const processGraphs = createProcessGraphRegistry([processDef]);
		const processActionRegistry = buildProcessActionRegistry({ processes: processGraphs });
		const process = deps.processes.create({
			processId: processDef.id,
			selectedTurnId: "llm_turn",
			lifecycleStatus: "active",
		});
		createSelectedTurnStart(deps, {
			instanceId: process.id,
			turnId: "llm_turn",
			turnType: "automatic",
			proposedTurnRecordId: "trn_startup",
			state: { kind: "starting", start: { kind: "automatic" } },
		});
		deps.leases.create({ instanceId: process.id, workerId: "wkr_stale", state: "busy" });
		const supervisor = createFakeWorkerSupervisor();

		await reconcileProcessesOnStartup({
			config: getDefaultConfig(),
			processes: deps.processes,
			leases: deps.leases,
			turnStarts: deps.turnStarts,
			turnRecords: deps.turnRecords,
			broadcaster: deps.broadcaster,
			supervisor,
			commands: {},
			processActionRegistry,
		});

		expect(deps.processes.getById(process.id)?.lifecycleStatus).toBe("active");
		expect(deps.leases.listActive()).toEqual([]);
		expect(supervisor.spawnCalls).toEqual([process.id]);
	});

	it("keeps an already adopted worker for a resumable current start", async () => {
		const deps = createTestDeps();
		const processDef = createFixtureProcess({
			id: "startup_model_fallback_process",
			entry: "llm_turn",
			turns: { llm_turn: createTestLlmTurn("llm_turn", {}) },
		});
		const processGraphs = createProcessGraphRegistry([processDef]);
		const processActionRegistry = buildProcessActionRegistry({ processes: processGraphs });
		const process = deps.processes.create({
			processId: processDef.id,
			selectedTurnId: "llm_turn",
			selectedTurnModelProfileId: "claude_fast",
			lifecycleStatus: "active",
		});
		const config = getDefaultConfig();
		const start = createSelectedTurnStart(deps, {
			instanceId: process.id,
			turnId: "llm_turn",
			turnType: "llm",
			proposedTurnRecordId: "trn_adopted",
			state: createTestTurnStart().state,
		});
		expect(deps.processes.getById(process.id)?.currentExecution).toEqual({
			kind: "worker_start",
			id: start.id,
		});
		const supervisor = createFakeWorkerSupervisor([process.id]);

		await reconcileProcessesOnStartup({
			config,
			processes: deps.processes,
			leases: deps.leases,
			turnStarts: deps.turnStarts,
			turnRecords: deps.turnRecords,
			broadcaster: deps.broadcaster,
			supervisor,
			commands: {},
			processActionRegistry,
		});

		expect(supervisor.callLog).toEqual([]);
	});
});
