import { EventEmitter } from "node:events";
import type { ExtensionProcessDefinition } from "@leitwerk-dev/process-sdk";
import {
	createIpcMessage,
	serializeMessage,
	WORKER_IPC_CONNECT_TOKEN_ENV,
} from "@leitwerk-dev/worker-protocol";
import type {
	ProcessVolume,
	WorkerExitInfo,
	WorkerRunner,
} from "@leitwerk-dev/worker-runners/types";
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
	return { deps, config, definition, process, supervisor, ensure, launch, webSocketIpc };
}

describe("createWorkerSupervisor", () => {
	it.each([
		false,
		true,
	])("resolves current profile budgets when a retained Docker=%s process starts", async (docker) => {
		const t = storageFixture();
		t.definition.runtime = { docker };
		if (!t.config.kubernetes) throw new Error("Expected Kubernetes config");
		t.config.kubernetes.docker = { worker_runtime_profile: "docker_vm" };
		t.config.worker_runtime_profiles = {
			generic: {
				image: "registry.test/ordinary:1",
				resources: { limits: { cpu: "4", memory: "8Gi" } },
			},
			docker_vm: {
				image: "registry.test/docker:1",
				resources: { requests: { cpu: "4", memory: "16Gi" }, limits: { cpu: "4", memory: "16Gi" } },
			},
		};
		await t.supervisor.spawnWorker(t.process.id);
		expect(t.launch.mock.calls[0]?.[0]).toMatchObject({
			docker,
			image: { reference: docker ? "registry.test/docker:1" : "registry.test/ordinary:1" },
			resources: { cpu: "4", memory: docker ? "16Gi" : "8Gi" },
			...(docker ? { resourceRequests: { cpu: "4", memory: "16Gi" } } : {}),
			volume: { id: "process-pvc" },
		});
	});

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

describe("runtime exit after graceful cleanup", () => {
	it.each([
		{ state: "cleanup", terminal: false, owning: true },
		{ state: "draining", terminal: false, owning: true },
		{ state: "cleanup", terminal: true, owning: true },
		{ state: "cleanup", terminal: false, owning: false },
	] as const)("reconciles exit after $state with terminal=$terminal owning=$owning", async ({
		state,
		terminal,
		owning,
	}) => {
		const t = storageFixture();
		let exit: ((info: WorkerExitInfo) => void) | undefined;
		t.launch.mockImplementation(async ({ instanceId, workerId }) => ({
			instanceId,
			workerId,
			unitId: "worker-pod",
			onExit(listener) {
				exit = listener;
			},
		}));
		await t.supervisor.spawnWorker(t.process.id);
		const input = t.launch.mock.calls[0]?.[0];
		const lease = t.deps.leases.getByInstance(t.process.id);
		if (!input || !lease?.turnStartRecordId) throw new Error("Missing start");
		t.deps.leases.compareAndSetBootstrapReceipt(lease.id, {
			kind: "automatic",
			startRecordId: lease.turnStartRecordId,
			workerLeaseId: lease.id,
			receiptEpoch: "epoch",
			readyAt: new Date().toISOString(),
		});
		class Socket extends EventEmitter {
			readyState = 1;
			send() {}
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
		socket.emit(
			"message",
			serializeMessage(
				createIpcMessage({
					type: "worker.turn_started",
					instanceId: t.process.id,
					workerId: input.workerId,
					messageId: crypto.randomUUID(),
					payload: { startRecordId: lease.turnStartRecordId, proposedTurnRecordId: "turn-storage" },
				}),
			),
		);
		await vi.waitFor(() =>
			expect(t.deps.turnRecords.getById("turn-storage")?.status).toBe("running"),
		);
		if (terminal)
			t.deps.turnRecords.update("turn-storage", {
				status: "succeeded",
				endedAt: new Date().toISOString(),
			});
		const otherLease = !owning
			? t.deps.leases.create({
					instanceId: t.process.id,
					workerId: "other-worker",
					state: "exited",
				})
			: null;
		if (otherLease)
			t.deps.turnRecords.update("turn-storage", { acceptedWorkerLeaseId: otherLease.id });
		t.deps.leases.update(lease.id, { state });
		exit?.({ exitCode: 0 });
		await vi.waitFor(() => expect(t.deps.leases.getById(lease.id)?.state).toBe("exited"));
		await vi.waitFor(() =>
			expect(t.deps.processes.getById(t.process.id)?.lifecycleStatus).toBe(
				terminal || !owning ? "active" : "error",
			),
		);
		expect(t.deps.turnRecords.getById("turn-storage")).toMatchObject({
			status: terminal ? "succeeded" : owning ? "failed" : "running",
			acceptedWorkerLeaseId: owning ? lease.id : otherLease?.id,
		});
		if (!terminal && owning)
			expect(t.deps.turnRecords.getById("turn-storage")?.errorClass).toBe("infrastructure");
		expect(t.deps.processes.getById(t.process.id)?.selectedTurnId).toBe("start");
	});
});
