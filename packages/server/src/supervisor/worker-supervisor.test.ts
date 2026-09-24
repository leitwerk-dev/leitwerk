import { EventEmitter } from "node:events";
import type { ExtensionProcessDefinition } from "@leitwerk-dev/process-sdk";
import {
	createIpcMessage,
	serializeMessage,
	WORKER_IPC_CONNECT_TOKEN_ENV,
} from "@leitwerk-dev/worker-protocol";
import type { ProcessVolume, WorkerRunner } from "@leitwerk-dev/worker-runners/types";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { getDefaultConfig } from "../config/config-loader.js";
import { closeDatabase } from "../db/database.js";
import { buildProcessActionRegistry } from "../process-action-registry.js";
import { createProcessEngine } from "../process-engine/engine.js";
import * as commitWrites from "../process-engine/writes/commit-writes.js";
import { createProcessOperationCoordinator } from "../process-operation-coordinator.js";
import {
	createFixtureAutomaticTurn,
	createFixtureProcess,
	createProcessGraphRegistry,
} from "../test-helpers/process-fixtures.js";
import { createSelectedTurnStart, createTestDeps } from "../test-helpers/unit-deps.js";
import { createIpcHandler } from "./ipc-handler.js";
import { createWorkerSupervisor } from "./worker-supervisor.js";
import { createWorkerWebSocketIpcManager } from "./worker-websocket-ipc.js";

function storageFixture(extensionSize = "50Gi", afterRecord?: () => Promise<void>) {
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
	const commands = createProcessEngine({
		...deps,
		processGraphs,
		processOperations: createProcessOperationCoordinator(),
		getSupervisor: () => supervisor,
		afterRecord,
	});
	const ipcHandler = createIpcHandler(
		{ ...deps, commands },
		{
			onWorkerTurnStartAccepted(instanceId, workerId, payload) {
				supervisor.acceptTurnStart(
					instanceId,
					workerId,
					payload.startRecordId,
					payload.turnRecordId,
				);
			},
		},
	);
	const webSocketIpc = createWorkerWebSocketIpcManager();
	const supervisor = createWorkerSupervisor({
		...deps,
		config,
		processGraphs,
		processActionRegistry: buildProcessActionRegistry({ processes: processGraphs }),
		ipcHandler,
		runnerRuntime: {
			webSocketIpc,
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
	return { deps, process, supervisor, ensure, launch, webSocketIpc };
}

describe("createWorkerSupervisor", () => {
	it.each([
		"hook",
		"derivation",
	] as const)("sends durable acceptance and replay over IPC despite %s failure", async (failure) => {
		const t = storageFixture(
			"50Gi",
			failure === "hook"
				? async () => {
						throw new Error("Hook failed");
					}
				: undefined,
		);
		await t.supervisor.spawnWorker(t.process.id);
		const input = t.launch.mock.calls[0]?.[0];
		if (!input) throw new Error("Missing worker launch");
		const lease = t.deps.leases.getByInstance(t.process.id);
		if (!lease?.turnStartRecordId) throw new Error("Missing worker start");
		t.deps.leases.compareAndSetBootstrapReceipt(lease.id, {
			kind: "automatic",
			startRecordId: lease.turnStartRecordId,
			workerLeaseId: lease.id,
			receiptEpoch: "epoch",
			readyAt: new Date().toISOString(),
		});
		class Socket extends EventEmitter {
			readyState = 1;
			sent: unknown[] = [];
			send(data: string) {
				this.sent.push(JSON.parse(data));
			}
			close() {
				this.readyState = 3;
				this.emit("close");
			}
		}
		const socket = new Socket();
		expect(
			t.webSocketIpc.bindSocket({ instanceId: t.process.id, workerId: input.workerId, socket }).ok,
		).toBe(true);
		socket.emit("message", input.env[WORKER_IPC_CONNECT_TOKEN_ENV]);
		const failDerivation =
			failure === "derivation"
				? vi.spyOn(commitWrites, "deriveReactions").mockImplementation(() => {
						throw new Error("Reaction derivation failed");
					})
				: undefined;
		try {
			for (let replay = 0; replay < 2; replay++) {
				socket.emit(
					"message",
					serializeMessage(
						createIpcMessage({
							type: "worker.turn_started",
							instanceId: t.process.id,
							workerId: input.workerId,
							messageId: crypto.randomUUID(),
							payload: {
								startRecordId: lease.turnStartRecordId,
								proposedTurnRecordId: "turn-storage",
							},
						}),
					),
				);
				await new Promise<void>((resolve) => setImmediate(resolve));
			}
			expect(socket.sent).toEqual(
				[0, 1].map(() =>
					expect.objectContaining({
						type: "worker.turn_start_accepted",
						instanceId: t.process.id,
						workerId: input.workerId,
						payload: { startRecordId: lease.turnStartRecordId, turnRecordId: "turn-storage" },
					}),
				),
			);
			expect(t.deps.turnRecords.listByInstance(t.process.id)).toMatchObject([
				{ status: "running", attemptNumber: 1 },
			]);
			if (failDerivation) expect(failDerivation).toHaveBeenCalledTimes(2);
		} finally {
			failDerivation?.mockRestore();
			socket.close();
		}
	});

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
