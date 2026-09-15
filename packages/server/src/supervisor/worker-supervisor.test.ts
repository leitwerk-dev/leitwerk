import type { ExtensionProcessDefinition } from "@leitwerk-dev/process-sdk";
import type {
	ProcessVolumeRequirements,
	StartWorkerInput,
	WorkerUnit,
} from "@leitwerk-dev/worker-runners/types";
import { describe, expect, it } from "vitest";
import { getDefaultConfig } from "../config/config-loader.js";
import { closeDatabase } from "../db/database.js";
import { buildProcessActionRegistry } from "../process-action-registry.js";
import {
	createFixtureAutomaticTurn,
	createFixtureProcess,
	createProcessGraphRegistry,
} from "../test-helpers/process-fixtures.js";
import { createTestDeps } from "../test-helpers/unit-deps.js";
import { createWorkerSupervisor } from "./worker-supervisor.js";
import { createWorkerWebSocketIpcManager } from "./worker-websocket-ipc.js";

function storageFixture(override: string | undefined, extensionSize: string | undefined) {
	const deps = createTestDeps();
	const config = getDefaultConfig();
	config.workers.runner = "kubernetes";
	config.process_configs = { storage_process: { storage_size: override, turn_configs: {} } };
	let resolverCalls = 0;
	const definition: ExtensionProcessDefinition = createFixtureProcess({
		id: "storage_process",
		entry: "start",
		turns: { start: createFixtureAutomaticTurn() },
	});
	definition.resolveStorageSize = ({ params, projects }) => {
		resolverCalls += 1;
		expect(params).toEqual({});
		expect(projects.map((project) => project.key)).toEqual(["repo"]);
		return extensionSize;
	};
	const processGraphs = createProcessGraphRegistry([definition]);
	const process = deps.processes.create({
		processId: definition.id,
		selectedTurnId: "start",
		lifecycleStatus: "active",
	});
	deps.projects.create({
		instanceId: process.id,
		key: "repo",
		repoLocator: "ssh://git@example.test/team/repo.git",
		baseBranch: "main",
	});
	const start = deps.turnStarts.create({
		instanceId: process.id,
		turnId: "start",
		turnType: "automatic",
		proposedTurnRecordId: "turn-storage",
		startKind: "selected_turn",
		recoveryTurnRecordId: null,
		continuation: null,
		state: { kind: "starting", start: { kind: "automatic" } },
	});
	deps.processes.update(process.id, { currentExecution: { kind: "worker_start", id: start.id } });
	const provisions: Array<ProcessVolumeRequirements | undefined> = [];
	const launches: StartWorkerInput[] = [];
	const supervisor = createWorkerSupervisor({
		...deps,
		config,
		processGraphs,
		processActionRegistry: buildProcessActionRegistry({ processes: processGraphs }),
		ipcHandler: { handleMessage() {} },
		runnerRuntime: {
			webSocketIpc: createWorkerWebSocketIpcManager(),
			volume: {
				async ensure(instanceId, requirements) {
					provisions.push(requirements);
					return { instanceId, id: "process-pvc", mountPath: "/state" };
				},
				async release() {},
				async deleteProcessResources() {},
			},
			runner: {
				async start(input): Promise<WorkerUnit> {
					launches.push(input);
					return {
						instanceId: input.instanceId,
						workerId: input.workerId,
						unitId: "worker-pod",
						onExit() {},
					};
				},
				async stop() {},
				async list() {
					return [];
				},
				async adopt() {
					throw new Error("unexpected adoption");
				},
			},
		},
	});
	return {
		process,
		supervisor,
		provisions,
		launches,
		resolverCalls: () => resolverCalls,
		async close() {
			await supervisor.detachAll("test complete");
			closeDatabase(deps.db);
		},
	};
}

describe("createWorkerSupervisor", () => {
	it("requires the shared runner runtime dependency", () => {
		expect(typeof createWorkerSupervisor).toBe("function");
		expect(getDefaultConfig().workers.runner).toBe("docker");
	});

	it.each([
		{ override: "128Mi", extensionSize: "50Gi", expected: "128Mi", calls: 0 },
		{ override: undefined, extensionSize: "50Gi", expected: "50Gi", calls: 1 },
		{ override: undefined, extensionSize: undefined, expected: "20Gi", calls: 1 },
	])("provisions $expected before starting the worker", async ({
		override,
		extensionSize,
		expected,
		calls,
	}) => {
		const t = storageFixture(override, extensionSize);
		try {
			await t.supervisor.spawnWorker(t.process.id);
			expect(t.provisions).toEqual([{ docker: false, size: expected }]);
			expect(t.resolverCalls()).toBe(calls);
			expect(t.launches).toHaveLength(1);
			expect(t.launches[0]?.volume?.id).toBe("process-pvc");
		} finally {
			await t.close();
		}
	});

	it("fails startup before provisioning or launching for an invalid extension size", async () => {
		const t = storageFixture(undefined, "invalid");
		try {
			await expect(t.supervisor.spawnWorker(t.process.id)).rejects.toThrow(
				"Worker runtime start failed",
			);
			expect(t.provisions).toEqual([]);
			expect(t.launches).toEqual([]);
		} finally {
			await t.close();
		}
	});
});
