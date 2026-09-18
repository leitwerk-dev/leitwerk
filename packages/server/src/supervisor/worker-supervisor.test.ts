import type { ExtensionProcessDefinition } from "@leitwerk-dev/process-sdk";
import type { ProcessVolume, WorkerRunner } from "@leitwerk-dev/worker-runners/types";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { getDefaultConfig } from "../config/config-loader.js";
import { closeDatabase } from "../db/database.js";
import { buildProcessActionRegistry } from "../process-action-registry.js";
import {
	createFixtureAutomaticTurn,
	createFixtureProcess,
	createProcessGraphRegistry,
} from "../test-helpers/process-fixtures.js";
import { createSelectedTurnStart, createTestDeps } from "../test-helpers/unit-deps.js";
import { createWorkerSupervisor } from "./worker-supervisor.js";
import { createWorkerWebSocketIpcManager } from "./worker-websocket-ipc.js";

function storageFixture(extensionSize = "50Gi") {
	const deps = createTestDeps();
	const config = getDefaultConfig();
	config.workers.runner = "kubernetes";
	const definition: ExtensionProcessDefinition = createFixtureProcess({
		id: "storage_process",
		entry: "start",
		turns: { start: createFixtureAutomaticTurn() },
	});
	definition.resolveStorageSize = ({ params, projects }) => {
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
	createSelectedTurnStart(deps, {
		instanceId: process.id,
		turnId: "start",
		turnType: "automatic",
		proposedTurnRecordId: "turn-storage",
		state: { kind: "starting", start: { kind: "automatic" } },
	});
	const ensure = vi.fn<ProcessVolume["ensure"]>(async (instanceId) => ({
		instanceId,
		id: "process-pvc",
		mountPath: "/state",
	}));
	const launch = vi.fn<WorkerRunner["start"]>(async ({ instanceId, workerId }) => ({
		instanceId,
		workerId,
		unitId: "worker-pod",
		onExit() {},
	}));
	const supervisor = createWorkerSupervisor({
		...deps,
		config,
		processGraphs,
		processActionRegistry: buildProcessActionRegistry({ processes: processGraphs }),
		ipcHandler: { handleMessage() {} },
		runnerRuntime: {
			webSocketIpc: createWorkerWebSocketIpcManager(),
			volume: {
				ensure,
				async release() {},
				async deleteProcessResources() {},
			},
			runner: {
				start: launch,
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
	onTestFinished(async () => {
		await supervisor.detachAll("test complete");
		closeDatabase(deps.db);
	});
	return { process, supervisor, ensure, launch };
}

describe("createWorkerSupervisor", () => {
	it("provisions the resolved size before starting the worker", async () => {
		const t = storageFixture();
		await t.supervisor.spawnWorker(t.process.id);
		expect(t.ensure).toHaveBeenCalledExactlyOnceWith(
			t.process.id,
			{ docker: false, size: "50Gi" },
			expect.anything(),
		);
		expect(t.launch.mock.calls.map(([input]) => input.volume?.id)).toEqual(["process-pvc"]);
	});

	it("fails startup before provisioning or launching for an invalid extension size", async () => {
		const t = storageFixture("invalid");
		await expect(t.supervisor.spawnWorker(t.process.id)).rejects.toThrow(
			"Worker runtime start failed",
		);
		expect(t.ensure).not.toHaveBeenCalled();
		expect(t.launch).not.toHaveBeenCalled();
	});
});
