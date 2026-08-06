import { describe, expect, it } from "vitest";
import { getDefaultConfig } from "../config/index.js";
import {
	createPiResourceBundleCache,
	createPiResourceBundlePinReconciler,
} from "../pi-resources/index.js";
import { buildProcessActionRegistry } from "../process-action-registry.js";
import { createFakeWorkerSupervisor } from "../test-helpers/fake-worker-supervisor.js";
import {
	createFixtureProcess,
	createFixtureServerAutomaticProcess,
	createProcessGraphRegistry,
} from "../test-helpers/process-fixtures.js";
import { createTestLlmTurn } from "../test-helpers/turn-fixtures.js";
import { createTestDeps } from "../test-helpers/unit-deps.js";
import { reconcileProcessesOnStartup } from "./startup-reconciliation.js";

describe("reconcileProcessesOnStartup", () => {
	it("fails a missing starting LLM bundle before it can be resumed", async () => {
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
		const start = deps.turnStarts.create({
			instanceId: process.id,
			turnId: "llm_turn",
			turnType: "llm",
			proposedTurnRecordId: "trn_missing_bundle",
			startKind: "selected_turn",
			recoveryTurnRecordId: null,
			continuation: null,
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
		deps.processes.update(process.id, { currentExecution: { kind: "worker_start", id: start.id } });
		const supervisor = createFakeWorkerSupervisor();
		const failures: unknown[] = [];

		await reconcileProcessesOnStartup({
			config: getDefaultConfig(),
			processes: deps.processes,
			leases: deps.leases,
			turnStarts: deps.turnStarts,
			turnRecords: deps.turnRecords,
			broadcaster: deps.broadcaster,
			supervisor,
			commands: {
				async drainServerAutomaticTurns() {},
				async recordWorkerFailure(_instanceId, payload) {
					failures.push(payload);
					const current = deps.processes.getById(process.id);
					if (!current) throw new Error("Expected process");
					return { ok: true, process: current, data: undefined };
				},
			},
			bundlePins: createPiResourceBundlePinReconciler({
				turnStarts: deps.turnStarts,
				turnRecords: deps.turnRecords,
				bundleCache: createPiResourceBundleCache(),
			}),
			processActionRegistry,
		});

		expect(failures).toEqual([
			{
				errorCode: "pi_resource_bundle_unavailable",
				message: "The Pi resource bundle for this worker start is unavailable",
			},
		]);
		expect(supervisor.spawnCalls).toEqual([]);
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
		const start = deps.turnStarts.create({
			instanceId: process.id,
			turnId: "llm_turn",
			turnType: "automatic",
			proposedTurnRecordId: "trn_startup",
			startKind: "selected_turn",
			recoveryTurnRecordId: null,
			continuation: null,
			state: { kind: "starting", start: { kind: "automatic" } },
		});
		deps.processes.update(process.id, { currentExecution: { kind: "worker_start", id: start.id } });
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
			commands: {
				async drainServerAutomaticTurns() {},
			},
			processActionRegistry,
		});

		expect(deps.processes.getById(process.id)?.lifecycleStatus).toBe("active");
		expect(deps.leases.listActive()).toEqual([]);
		expect(supervisor.spawnCalls).toEqual([process.id]);
	});

	it("keeps a compatible adopted worker that already uses the runtime model fallback", async () => {
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
		config.pi.model_profiles = config.pi.model_profiles.filter(
			(profile) => profile.id !== "claude_fast",
		);
		const supervisor = createFakeWorkerSupervisor([process.id]);

		await reconcileProcessesOnStartup({
			config,
			processes: deps.processes,
			leases: deps.leases,
			turnStarts: deps.turnStarts,
			turnRecords: deps.turnRecords,
			broadcaster: deps.broadcaster,
			supervisor,
			commands: { async drainServerAutomaticTurns() {} },
			processActionRegistry,
		});

		expect(supervisor.callLog).toEqual([]);
	});

	it("stops adopted workers before draining selected server-owned turns", async () => {
		const deps = createTestDeps();
		const processDef = createFixtureServerAutomaticProcess({ id: "startup_server_auto_process" });
		const processGraphs = createProcessGraphRegistry([processDef]);
		const processActionRegistry = buildProcessActionRegistry({ processes: processGraphs });
		const process = deps.processes.create({
			processId: processDef.id,
			selectedTurnId: "server_auto",
			lifecycleStatus: "active",
		});
		const serverTurn = deps.turnRecords.create({
			instanceId: process.id,
			turnId: "server_auto",
			turnType: "server_automatic",
			status: "running",
		});
		deps.processes.update(process.id, {
			currentExecution: { kind: "server_turn", id: serverTurn.id },
		});
		const supervisor = createFakeWorkerSupervisor([process.id]);

		await reconcileProcessesOnStartup({
			config: getDefaultConfig(),
			processes: deps.processes,
			leases: deps.leases,
			turnStarts: deps.turnStarts,
			turnRecords: deps.turnRecords,
			broadcaster: deps.broadcaster,
			supervisor,
			commands: {
				async drainServerAutomaticTurns(instanceId) {
					supervisor.callLog.push(`drain:${instanceId}`);
				},
			},
			processActionRegistry,
		});

		expect(supervisor.callLog).toEqual([
			`stop:${process.id}:startup_reconciliation:server_automatic`,
			`drain:${process.id}`,
		]);
	});
});
