import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ResolvedWorkerProcess } from "@leitwerk-dev/extension-runtime";
import { createEventBus, createWorkerProcessBuilder, llmTurn } from "@leitwerk-dev/process-sdk";
import type { InputDelivery, WorkerStartPayload } from "@leitwerk-dev/worker-protocol";
import { describe, expect, it, vi } from "vitest";
import { FakeGitOps } from "../fakes/fake-git-ops.js";
import { StubPiTreeHandleFactory } from "./stub-pi-tree-handle.js";
import {
	createManualWorkerRuntimeScheduler,
	createWorkerRuntimeHarness,
	type WorkerRuntimeHarness,
	type WorkerRuntimeHarnessOptions,
} from "./worker-runtime-harness.js";
import { createTestLlmWorkerStartPayload } from "./worker-start-payload.js";

const INSTANCE_ID = "proc_test";

function automaticProcess(
	handler: Parameters<ReturnType<typeof createWorkerProcessBuilder>["turn"]>[1],
): ResolvedWorkerProcess {
	const builder = createWorkerProcessBuilder();
	builder.start("run");
	builder.turn("run", handler);
	const definition = builder.getDefinition();
	return {
		processId: "harness_process",
		startTurnId: "run",
		turns: new Map([
			[
				"run",
				{
					definition: {
						id: "run",
						kind: "automatic",
						description: "Harness automatic turn",
					} as never,
				},
			],
		]),
		definition,
		params: {},
		state: {},
	};
}

function llmProcess(): ResolvedWorkerProcess {
	const turn = {
		...llmTurn({
			description: "Harness LLM turn",
			availableTools: [],
			branchType: "primary",
			context: "fresh",
			prompt: async () => "Run the harness turn",
			turnEnd: { outcome: "done", params: {}, complete: true },
		}),
		id: "run",
	};
	const builder = createWorkerProcessBuilder();
	builder.start("run");
	builder.turn("run", async (run) => {
		await run.turn(turn);
	});
	const definition = builder.getDefinition();
	return {
		processId: "harness_process",
		startTurnId: "run",
		turns: new Map([["run", { definition: turn }]]),
		definition,
		params: {},
		state: {},
	};
}

function input(sequence: number, bodyMarkdown = `input ${sequence}`): InputDelivery {
	return {
		inputId: `inp_${sequence}`,
		sequence,
		source: "operator",
		kind: "message",
		target: null,
		receivedAt: "2025-01-01T00:00:00.000Z",
		bodyMarkdown,
	};
}

function targetedInput(
	sequence: number,
	bodyMarkdown = `targeted input ${sequence}`,
): InputDelivery {
	return {
		...input(sequence, bodyMarkdown),
		target: { semanticRef: "currentPrimaryPathLeaf" },
	};
}

function automaticStart(
	options: {
		state?: "starting" | "accepted";
		pendingInputs?: InputDelivery[];
		startRecordId?: string;
		turnRecordId?: string;
	} = {},
): WorkerStartPayload {
	const startRecordId = options.startRecordId ?? "start_1";
	const turnRecordId = options.turnRecordId ?? "trn_1";
	return {
		processSnapshot: {
			id: INSTANCE_ID,
			processId: "harness_process",
			selectedTurnId: "run",
			lifecycleStatus: "active",
			paramsJson: "{}",
			stateJson: "{}",
		},
		projectSnapshots: [],
		workerLeaseId: "lease_1",
		turnStart: {
			id: startRecordId,
			instanceId: INSTANCE_ID,
			turnId: "run",
			turnType: "automatic",
			proposedTurnRecordId: turnRecordId,
			startKind: "selected_turn",
			recoveryTurnRecordId: null,
			continuation: null,
			state:
				options.state === "accepted"
					? { kind: "accepted", turnRecordId }
					: { kind: "starting", start: { kind: "automatic" } },
			createdAt: "2025-01-01T00:00:00.000Z",
			updatedAt: "2025-01-01T00:00:00.000Z",
		},
		pendingInputs: options.pendingInputs ?? [],
		bootstrap: { kind: "automatic" },
		treePaths: { primaryTreeFile: "/tmp/harness-tree.jsonl", workspaceRoot: "/tmp" },
		resume: false,
	};
}

function llmStart(root: string): WorkerStartPayload {
	return createTestLlmWorkerStartPayload({
		root,
		processSnapshot: automaticStart().processSnapshot,
	});
}

function createLlmHarness(
	tempPrefix: string,
	overrides: Partial<WorkerRuntimeHarnessOptions["adapters"]> = {},
) {
	const adapters: WorkerRuntimeHarnessOptions["adapters"] = {
		piFactory: new StubPiTreeHandleFactory(),
		gitOps: new FakeGitOps(new Map()),
		resolveWorkerProcess: () => llmProcess(),
		...overrides,
	};
	const root = mkdtempSync(path.join(tmpdir(), tempPrefix));
	const workspaceRoot = path.join(root, "workspace");
	const primaryTreeFile = path.join(root, "tree", "primary.jsonl");
	mkdirSync(workspaceRoot, { recursive: true });
	const startPayload = llmStart(root);
	const harness = createWorkerRuntimeHarness({ adapters, startPayload });
	return { harness, root, workspaceRoot, primaryTreeFile, startPayload };
}

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function createAutomaticHarness(
	handler: Parameters<ReturnType<typeof createWorkerProcessBuilder>["turn"]>[1] = async (run) => {
		await run.complete({ outcome: "done", params: {} });
	},
): WorkerRuntimeHarness {
	const process = automaticProcess(handler);
	return createWorkerRuntimeHarness({
		adapters: {
			piFactory: new StubPiTreeHandleFactory(),
			gitOps: new FakeGitOps(new Map()),
			resolveWorkerProcess: () => process,
		},
	});
}

async function startHarness(harness: WorkerRuntimeHarness): Promise<void> {
	await harness.start(automaticStart());
}

function types(harness: WorkerRuntimeHarness): string[] {
	return harness.outgoing.map((message) => message.type);
}

async function exhaustSnapshotRetries(harness: WorkerRuntimeHarness): Promise<void> {
	for (let retry = 0; retry < 3; retry++) {
		await harness.scheduler.advanceBy(10_000);
		await harness.flush();
	}
}

describe("worker runtime harness", () => {
	it("observes transport-ready startup through outgoing messages", async () => {
		const harness = createAutomaticHarness();
		await harness.connect();
		expect(types(harness)).toEqual(["worker.hello"]);
		expect(harness.outgoing[0]?.sentAt).toBe("2025-01-01T00:00:00.000Z");
		expect(harness.transportStartCount).toBe(1);
	});

	it("advances timeouts and sleeps deterministically", async () => {
		const scheduler = createManualWorkerRuntimeScheduler();
		let timedOut = false;
		const timeout = scheduler.setTimeout(() => {
			timedOut = true;
		}, 200);
		scheduler.clearTimeout(timeout);
		let slept = false;
		void scheduler.sleep(250).then(() => {
			slept = true;
		});
		await scheduler.advanceBy(300);
		expect(timedOut).toBe(false);
		expect(slept).toBe(true);
	});

	it("does not execute an automatic turn before start acceptance", async () => {
		const handler = vi.fn(async (run) => {
			await run.complete({ outcome: "done", params: {} });
		});
		const harness = createAutomaticHarness(handler);
		await startHarness(harness);
		expect(handler).not.toHaveBeenCalled();
		expect(types(harness)).toContain("worker.turn_started");
		expect(types(harness)).not.toContain("worker.turn_outcome");
	});

	it("executes an accepted start exactly once when acceptance is replayed", async () => {
		const handler = vi.fn(async (run) => {
			await run.complete({ outcome: "done", params: {} });
		});
		const harness = createAutomaticHarness(handler);
		await startHarness(harness);
		const accepted = { startRecordId: "start_1", turnRecordId: "trn_1" };
		harness.deliver("worker.turn_start_accepted", accepted);
		harness.deliver("worker.turn_start_accepted", accepted);
		await harness.flush();
		expect(handler).toHaveBeenCalledOnce();
		expect(types(harness).filter((type) => type === "worker.turn_outcome")).toHaveLength(1);
	});

	it("runs a start that was already accepted without requesting acceptance again", async () => {
		const handler = vi.fn(async (run) => {
			await run.complete({ outcome: "done", params: {} });
		});
		const harness = createAutomaticHarness(handler);
		await harness.start(automaticStart({ state: "accepted" }));
		expect(handler).toHaveBeenCalledOnce();
		expect(types(harness)).not.toContain("worker.turn_started");

		await harness.stop("accepted_start_complete");
		expect(types(harness).filter((type) => type.startsWith("worker.cleanup_"))).toEqual([
			"worker.cleanup_started",
			"worker.cleanup_completed",
		]);
		expect(harness.transportStopCount).toBe(1);
	});

	it("consumes bootstrap inputs in FIFO sequence before the accepted turn", async () => {
		const handler = vi.fn(async (run) => {
			await run.complete({ outcome: "done", params: {} });
		});
		const harness = createAutomaticHarness(handler);
		await harness.start(automaticStart({ state: "accepted", pendingInputs: [input(1), input(2)] }));
		const consumed = harness.outgoing.filter((message) => message.type === "worker.input_consumed");
		expect(consumed.map((message) => message.payload.sequence)).toEqual([1, 2]);
		expect(types(harness).indexOf("worker.input_consumed")).toBeLessThan(
			types(harness).indexOf("worker.turn_outcome"),
		);
	});

	it("serializes live input batches and preserves FIFO ordering", async () => {
		const harness = createAutomaticHarness();
		await startHarness(harness);
		for (const delivery of [input(1), input(2), input(3)]) {
			harness.deliver("input.batch", {
				inputs: [delivery],
			});
		}
		await harness.flush();
		const consumed = harness.outgoing.filter((message) => message.type === "worker.input_consumed");
		expect(consumed.map((message) => message.payload.sequence)).toEqual([1, 2, 3]);
	});

	it("applies a targeted FIFO input through the runtime interface", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "worker-runtime-targeted-fifo-"));
		mkdirSync(path.join(root, "workspace"), { recursive: true });
		const piFactory = new StubPiTreeHandleFactory();
		const adapters = {
			piFactory,
			gitOps: new FakeGitOps(new Map()),
			resolveWorkerProcess: () => llmProcess(),
		};
		const seed = createWorkerRuntimeHarness({ adapters });
		await seed.startLlmTo("worker.turn_outcome", llmStart(root));
		await seed.stop("seed_complete");

		const harness = createWorkerRuntimeHarness({ adapters });
		const start = llmStart(root);
		start.resume = true;
		start.workerLeaseId = "lease_2";
		start.turnStart = {
			...start.turnStart,
			id: "start_2",
			proposedTurnRecordId: "trn_2",
		};
		start.pendingInputs = [{ ...input(1), kind: "system_event" }, targetedInput(2), input(3)];
		await harness.startLlmTo("worker.turn_outcome", start);
		await harness.flush();
		const consumed = harness.outgoing
			.filter((message) => message.type === "worker.input_consumed")
			.map((message) => [message.payload.sequence, message.payload.deliveryMode]);
		expect(consumed).toEqual([
			[1, "steer"],
			[2, "append_message"],
			[3, "prompt"],
		]);
	});

	it("ignores abort and input messages before worker.start", async () => {
		const harness = createAutomaticHarness();
		await harness.connect();
		harness.deliver("worker.abort_turn", { reason: "stale" });
		harness.deliver("input.batch", {
			inputs: [input(1)],
		});
		await harness.flush();
		expect(types(harness)).toEqual(["worker.hello"]);
	});

	it("ignores acceptance for a stale start record", async () => {
		const handler = vi.fn();
		const harness = createAutomaticHarness(handler);
		await startHarness(harness);
		harness.deliver("worker.turn_start_accepted", {
			startRecordId: "start_stale",
			turnRecordId: "trn_stale",
		});
		await harness.flush();
		expect(handler).not.toHaveBeenCalled();
	});

	it("re-announces identity and input position on reconnect", async () => {
		const harness = createAutomaticHarness();
		await startHarness(harness);
		harness.reconnect();
		expect(types(harness).slice(-2)).toEqual(["worker.hello", "worker.heartbeat"]);
		const heartbeat = harness.outgoing.at(-1);
		expect(heartbeat?.type === "worker.heartbeat" && heartbeat.payload.lastSequenceConsumed).toBe(
			0,
		);
	});

	it("accepts credential acknowledgements without reflecting credential material", async () => {
		const harness = createAutomaticHarness();
		await startHarness(harness);
		harness.deliver("worker.credential_update_accepted", {
			providerId: "test-provider",
			accepted: true,
			currentRevision: 2,
		});
		await harness.flush();
		expect(JSON.stringify(harness.outgoing)).not.toContain("test-secret");
		expect(harness.exitCodes).toEqual([]);
	});

	it("reports cleanup in order and exits after a graceful stop", async () => {
		const harness = createAutomaticHarness();
		await startHarness(harness);
		harness.deliver("worker.stop", {
			reason: "operator_stop",
		});
		await harness.flush();
		const cleanupTypes = types(harness).filter((type) => type.startsWith("worker.cleanup_"));
		expect(cleanupTypes).toEqual(["worker.cleanup_started", "worker.cleanup_completed"]);
		expect(harness.transportStopCount).toBe(1);
		expect(harness.exitCodes).toEqual([0]);
	});

	it("stops cleanly before receiving worker.start without attempting a snapshot", async () => {
		const uploadSnapshot = vi.fn(async () => ({ kind: "missing" as const }));
		const harness = createWorkerRuntimeHarness({
			adapters: {
				piFactory: new StubPiTreeHandleFactory(),
				gitOps: new FakeGitOps(new Map()),
				sessionSnapshots: { uploadSnapshot },
			},
		});
		await harness.connect();

		await harness.stop("test_stop_before_worker_start");

		expect(uploadSnapshot).not.toHaveBeenCalled();
		expect(types(harness).filter((type) => type.startsWith("worker.cleanup_"))).toEqual([
			"worker.cleanup_started",
			"worker.cleanup_completed",
		]);
		expect(harness.transportStopCount).toBe(1);
	});

	it("reduces a transport stop while bootstrap is still running", async () => {
		const bootstrap = deferred();
		const { harness } = createLlmHarness("worker-runtime-message-stop-bootstrap-", {
			resolveWorkerProcess: async () => {
				await bootstrap.promise;
				return llmProcess();
			},
		});
		await harness.start();

		harness.deliver("worker.stop", {
			reason: "operator_stop_during_bootstrap",
		});
		harness.deliver("input.batch", {
			inputs: [input(1)],
		});
		await harness.flush();

		expect(types(harness)).not.toContain("worker.input_consumed");
		expect(types(harness)).not.toContain("worker.cleanup_started");
		expect(harness.transportStopCount).toBe(0);

		bootstrap.resolve();
		await harness.waitForMessage("worker.cleanup_completed");

		expect(types(harness)).not.toContain("worker.input_consumed");
		expect(harness.transportStopCount).toBe(1);
		expect(harness.exitCodes).toEqual([0]);
	});

	it("waits for bootstrap and skips final LLM snapshot when acceptance never opened Pi", async () => {
		const bootstrap = deferred();
		const uploads: string[] = [];
		const { harness } = createLlmHarness("worker-runtime-stop-bootstrap-", {
			resolveWorkerProcess: async () => {
				await bootstrap.promise;
				return llmProcess();
			},
			sessionSnapshots: {
				async uploadSnapshot(_treeFile, reason) {
					uploads.push(reason);
					return { kind: "missing" };
				},
			},
		});
		await harness.start();

		let stopped = false;
		const stop = harness.stop("test_stop_during_bootstrap").then(() => {
			stopped = true;
		});
		await harness.flush();
		expect(stopped).toBe(false);
		expect(harness.transportStopCount).toBe(0);

		bootstrap.resolve();
		await stop;

		expect(uploads).toEqual([]);
		expect(harness.transportStopCount).toBe(1);
		expect(types(harness)).toContain("worker.cleanup_completed");
	});

	it("waits for accepted-start activation before cleanup", async () => {
		const activation = deferred();
		const activationStarted = deferred();
		class BlockedActivationFactory extends StubPiTreeHandleFactory {
			override async createPrimaryTreeHandle(
				options: Parameters<StubPiTreeHandleFactory["createPrimaryTreeHandle"]>[0],
			) {
				activationStarted.resolve();
				await activation.promise;
				return super.createPrimaryTreeHandle(options);
			}
		}
		const { harness } = createLlmHarness("worker-runtime-stop-activation-", {
			piFactory: new BlockedActivationFactory(),
		});
		await harness.start();
		await harness.waitForMessage("worker.ready");
		await harness.acceptStart();
		await activationStarted.promise;
		const stop = harness.stop("stop_during_activation");
		await harness.flush();
		expect(types(harness)).not.toContain("worker.cleanup_started");
		activation.resolve();
		await stop;
		expect(types(harness)).toContain("worker.cleanup_completed");
	});

	it("waits for selected-turn execution before cleanup", async () => {
		const turn = deferred();
		const harness = createAutomaticHarness(async (run) => {
			await turn.promise;
			await run.complete({ outcome: "done", params: {} });
		});
		await harness.start(automaticStart({ state: "accepted" }));
		const stop = harness.stop("stop_during_turn");
		await harness.flush();
		expect(types(harness)).not.toContain("worker.cleanup_started");
		turn.resolve();
		await stop;
		expect(types(harness)).toContain("worker.cleanup_completed");
	});

	it("waits for an active snapshot before cleanup and transport shutdown", async () => {
		const snapshot = deferred();
		let snapshotStarted = false;
		const { harness } = createLlmHarness("worker-runtime-stop-snapshot-", {
			sessionSnapshots: {
				async uploadSnapshot() {
					snapshotStarted = true;
					await snapshot.promise;
					return { kind: "uploaded", bytes: 1 };
				},
			},
		});
		await harness.start();
		await harness.waitForMessage("worker.ready");
		expect(snapshotStarted).toBe(true);

		let stopped = false;
		const stop = harness.stop("test_stop_during_snapshot").then(() => {
			stopped = true;
		});
		await harness.flush();
		expect(stopped).toBe(false);
		expect(types(harness)).not.toContain("worker.cleanup_started");
		expect(harness.transportStopCount).toBe(0);

		snapshot.resolve();
		await stop;

		expect(types(harness)).toContain("worker.cleanup_completed");
		expect(harness.transportStopCount).toBe(1);
	});

	it("reduces a transport stop while input delivery is still running", async () => {
		const piFactory = new StubPiTreeHandleFactory();
		const { harness } = createLlmHarness("worker-runtime-stop-input-", { piFactory });
		await harness.startLlmTo("worker.turn_outcome");

		const handle = piFactory.sessions[0];
		if (!handle) throw new Error("Expected a Pi session");
		const inputDelivery = deferred();
		vi.spyOn(handle, "prompt").mockImplementation(() => inputDelivery.promise);

		harness.deliver("input.batch", {
			inputs: [input(1)],
		});
		await harness.flush();
		harness.deliver("worker.stop", {
			reason: "operator_stop_during_input",
		});
		harness.deliver("input.batch", {
			inputs: [input(2)],
		});
		await harness.flush();

		expect(types(harness)).not.toContain("worker.cleanup_started");
		expect(types(harness)).not.toContain("worker.input_consumed");

		inputDelivery.resolve();
		await harness.waitForMessage("worker.cleanup_completed");

		const consumed = harness.outgoing.filter((message) => message.type === "worker.input_consumed");
		expect(consumed).toHaveLength(1);
		expect(consumed[0]?.type === "worker.input_consumed" && consumed[0].payload.inputId).toBe(
			"inp_1",
		);
		expect(harness.exitCodes).toEqual([0]);
	});

	it("stops once and exits nonzero on a fatal transport failure", async () => {
		const stderr = { write: vi.fn(() => true) };
		const process = automaticProcess(async (run) => {
			await run.complete({ outcome: "done", params: {} });
		});
		const harness = createWorkerRuntimeHarness({
			adapters: {
				piFactory: new StubPiTreeHandleFactory(),
				gitOps: new FakeGitOps(new Map()),
				resolveWorkerProcess: () => process,
				stderr: stderr as never,
			},
		});
		await startHarness(harness);
		harness.failTransport(new Error("socket lost"));
		harness.failTransport(new Error("duplicate"));
		await harness.flush();
		expect(harness.transportStopCount).toBe(1);
		expect(harness.exitCodes).toEqual([1]);
		expect(stderr.write).toHaveBeenCalledWith("socket lost\n");
	});

	it("ignores a bootstrap completion after a fatal transport failure", async () => {
		const process = automaticProcess(async (run) => {
			await run.complete({ outcome: "done", params: {} });
		});
		const bootstrap = deferred();
		const harness = createWorkerRuntimeHarness({
			adapters: {
				piFactory: new StubPiTreeHandleFactory(),
				gitOps: new FakeGitOps(new Map()),
				resolveWorkerProcess: async () => {
					await bootstrap.promise;
					return process;
				},
			},
		});
		await harness.start(automaticStart());
		expect(types(harness)).not.toContain("worker.ready");

		harness.failTransport(new Error("socket lost during bootstrap"));
		bootstrap.resolve();
		await harness.flush();

		expect(types(harness)).not.toContain("worker.ready");
		expect(types(harness)).not.toContain("worker.heartbeat");
		expect(types(harness)).not.toContain("worker.turn_started");
		expect(harness.transportStopCount).toBe(1);
		expect(harness.exitCodes).toEqual([1]);
	});

	it("uploads ready and outcome snapshots before publishing the LLM outcome", async () => {
		const uploads: string[] = [];
		const createResultImageTool = vi.fn(() => null);
		const { harness, root } = createLlmHarness("worker-runtime-snapshot-", {
			resultImageTools: { create: createResultImageTool },
			sessionSnapshots: {
				async uploadSnapshot(_treeFile, reason) {
					if (reason === "after_worker_ready") {
						expect(types(harness)).toContain("worker.ready");
					}
					uploads.push(reason);
					return { kind: "uploaded", bytes: 1 };
				},
			},
		});
		await harness.startLlmTo("worker.turn_outcome");
		harness.deliver("worker.stop", {
			reason: "snapshot_test_complete",
		});
		await harness.waitForMessage("worker.cleanup_completed");
		expect(uploads).toEqual([
			"after_worker_ready",
			"before_turn_outcome",
			"before_cleanup_completed",
		]);
		expect(types(harness)).toContain("worker.turn_outcome");
		expect(createResultImageTool).toHaveBeenCalledWith({
			workspaceRoot: path.join(root, "workspace"),
			instanceId: INSTANCE_ID,
			turnRecordId: "trn_1",
		});
		expect(
			readFileSync(path.join(root, "agent", INSTANCE_ID, "lease_1", "auth.json"), "utf8"),
		).toContain("test-secret");
		expect(JSON.stringify(harness.outgoing)).not.toContain("test-secret");
	});

	it("runs the final snapshot before releasing live resources", async () => {
		const order: string[] = [];
		class OrderedCleanupFactory extends StubPiTreeHandleFactory {
			override async createPrimaryTreeHandle(
				options: Parameters<StubPiTreeHandleFactory["createPrimaryTreeHandle"]>[0],
			) {
				const handle = await super.createPrimaryTreeHandle(options);
				const close = handle.close.bind(handle);
				handle.close = async () => {
					order.push("cleanup");
					await close();
				};
				return handle;
			}
		}
		const { harness } = createLlmHarness("worker-runtime-cleanup-order-", {
			piFactory: new OrderedCleanupFactory(),
			sessionSnapshots: {
				async uploadSnapshot(_treeFile, reason) {
					if (reason === "before_cleanup_completed") order.push("final_snapshot");
					return { kind: "uploaded", bytes: 1 };
				},
			},
		});
		await harness.startLlmTo("worker.turn_outcome");
		await harness.stop("verify_cleanup_order");
		expect(order).toEqual(["final_snapshot", "cleanup"]);
	});

	it("forwards an operator abort to the active Pi turn", async () => {
		const prompt = deferred();
		let abortCount = 0;
		class AbortableFactory extends StubPiTreeHandleFactory {
			override async createPrimaryTreeHandle(
				options: Parameters<StubPiTreeHandleFactory["createPrimaryTreeHandle"]>[0],
			) {
				const handle = await super.createPrimaryTreeHandle(options);
				handle.beforeTurn = () => prompt.promise;
				handle.abortTurn = async () => {
					abortCount++;
					prompt.resolve();
				};
				return handle;
			}
		}
		const { harness } = createLlmHarness("worker-runtime-abort-", {
			piFactory: new AbortableFactory(),
		});
		await harness.startLlmTo("worker.state");
		harness.deliver("worker.abort_turn", { reason: "operator" });
		await harness.flush();
		expect(abortCount).toBe(1);
		expect(types(harness)).toContain("worker.turn_failed");
	});

	it("taints a drifted session and leaves later inputs unacknowledged", async () => {
		class DriftingFactory extends StubPiTreeHandleFactory {
			override async createPrimaryTreeHandle(
				options: Parameters<StubPiTreeHandleFactory["createPrimaryTreeHandle"]>[0],
			) {
				const handle = await super.createPrimaryTreeHandle(options);
				handle.failNextTurnWithBranchDrift();
				return handle;
			}
		}
		const extensionEvents = createEventBus();
		const taintReasons: unknown[] = [];
		extensionEvents.on("worker.session_tainted", (payload) => taintReasons.push(payload));
		const { harness } = createLlmHarness("worker-runtime-taint-", {
			piFactory: new DriftingFactory(),
			extensionEvents,
		});
		await harness.startLlmTo("worker.turn_failed");
		harness.deliver("input.batch", {
			inputs: [input(1)],
		});
		await harness.flush();
		expect(taintReasons).toHaveLength(1);
		expect(types(harness)).toContain("worker.turn_failed");
		expect(types(harness)).not.toContain("worker.input_consumed");
	});

	it("orders busy, outcome, and idle reporting around turn execution", async () => {
		const harness = createAutomaticHarness();
		await startHarness(harness);
		await harness.acceptStart();
		const lifecycle = harness.outgoing.filter(
			(message) => message.type === "worker.state" || message.type === "worker.turn_outcome",
		);
		expect(lifecycle.map((message) => message.type)).toEqual([
			"worker.state",
			"worker.turn_outcome",
			"worker.state",
		]);
		expect(lifecycle[0]?.type === "worker.state" && lifecycle[0].payload.to).toBe("busy");
		expect(lifecycle[2]?.type === "worker.state" && lifecycle[2].payload.to).toBe("idle");
	});

	it("fails before acceptance when bootstrap cannot resolve the process", async () => {
		const harness = createWorkerRuntimeHarness({
			adapters: {
				piFactory: new StubPiTreeHandleFactory(),
				gitOps: new FakeGitOps(new Map()),
				resolveWorkerProcess: () => {
					throw new Error("process catalog unavailable");
				},
			},
		});
		await harness.start(automaticStart());
		await harness.waitForMessage("worker.failed");
		expect(types(harness)).not.toContain("worker.turn_started");
		expect(types(harness)).not.toContain("worker.turn_outcome");
		expect(harness.exitCodes).toEqual([1]);
	});

	it("attempts the best-effort bootstrap snapshot before publishing worker.failed", async () => {
		const snapshot = deferred();
		let snapshotStarted = false;
		const { harness } = createLlmHarness("worker-runtime-bootstrap-failure-snapshot-", {
			resolveWorkerProcess: () => {
				throw new Error("process catalog unavailable");
			},
			sessionSnapshots: {
				async uploadSnapshot() {
					snapshotStarted = true;
					await snapshot.promise;
					return { kind: "uploaded", bytes: 1 };
				},
			},
		});
		await harness.start();
		expect(snapshotStarted).toBe(true);
		expect(types(harness)).not.toContain("worker.failed");
		snapshot.resolve();
		await harness.waitForMessage("worker.failed");
		expect(harness.exitCodes).toEqual([1]);
	});

	it("redelivers only inputs after the reconnect cursor", async () => {
		const harness = createAutomaticHarness();
		await harness.start(automaticStart({ state: "accepted", pendingInputs: [input(2), input(1)] }));
		await harness.waitForMessage("worker.turn_outcome");
		harness.reconnect();
		const heartbeat = harness.outgoing.at(-1);
		expect(heartbeat?.type === "worker.heartbeat" && heartbeat.payload.lastSequenceConsumed).toBe(
			2,
		);
		harness.deliver("input.batch", {
			inputs: [input(2, "redelivered"), input(3)],
		});
		await harness.flush();
		const consumed = harness.outgoing
			.filter((message) => message.type === "worker.input_consumed")
			.map((message) => message.payload.sequence);
		expect(consumed).toEqual([1, 2, 3]);
	});

	it("blocks terminal turn publication when mandatory snapshots fail", async () => {
		const { harness } = createLlmHarness("worker-runtime-required-snapshot-", {
			sessionSnapshots: {
				async uploadSnapshot(_treeFile, reason) {
					if (reason === "before_turn_outcome") throw new Error("snapshot store unavailable");
					return { kind: "uploaded", bytes: 1 };
				},
			},
		});
		await harness.startLlmTo("worker.state");
		await exhaustSnapshotRetries(harness);
		expect(types(harness)).not.toContain("worker.turn_outcome");
		const failed = harness.outgoing.find((message) => message.type === "worker.turn_failed");
		expect(failed?.type === "worker.turn_failed" && failed.payload.errorClass).toBe(
			"infrastructure",
		);
	});

	it("replaces an existing turn failure when its mandatory snapshot fails", async () => {
		const piFactory = new StubPiTreeHandleFactory();
		const createHandle = piFactory.createPrimaryTreeHandle.bind(piFactory);
		piFactory.createPrimaryTreeHandle = async (options) => {
			const handle = await createHandle(options);
			(handle as (typeof piFactory.sessions)[number]).beforeTurn = () => {
				throw new Error("original turn execution failed");
			};
			return handle;
		};
		const { harness } = createLlmHarness("worker-runtime-failed-snapshot-", {
			piFactory,
			sessionSnapshots: {
				async uploadSnapshot(_treeFile, reason) {
					if (reason === "before_turn_failed") {
						throw new Error("failed-turn snapshot unavailable");
					}
					return { kind: "uploaded", bytes: 1 };
				},
			},
		});
		await harness.startLlmTo("worker.state");
		await exhaustSnapshotRetries(harness);
		const failures = harness.outgoing.filter((message) => message.type === "worker.turn_failed");
		expect(failures).toHaveLength(1);
		expect(failures[0]?.type === "worker.turn_failed" && failures[0].payload.errorClass).toBe(
			"infrastructure",
		);
		expect(
			failures[0]?.type === "worker.turn_failed" && failures[0].payload.errorSummary,
		).toContain("snapshot");
		expect(types(harness)).not.toContain("worker.turn_outcome");
		expect(types(harness)).toContain("worker.lifecycle_parked");
	});

	it("applies credential refresh CAS acceptance and stops after rejection", async () => {
		const samples = [
			{ values: { apiKey: "initial" }, fingerprint: "initial" },
			{ values: { apiKey: "replacement-one" }, fingerprint: "replacement-one" },
			{ values: { apiKey: "replacement-one" }, fingerprint: "replacement-one" },
			{ values: { apiKey: "replacement-two" }, fingerprint: "replacement-two" },
		];
		const sampleCredentials = vi.fn(async () => {
			const sample = samples.shift();
			if (!sample) throw new Error("Unexpected credential sample");
			return sample;
		});
		const { harness } = createLlmHarness("worker-runtime-credentials-", {
			sampleCredentials,
		});
		await harness.start();
		await harness.waitForMessage("worker.ready");
		await harness.flush();
		await harness.scheduler.advanceBy(500);
		const first = await harness.waitForMessage("worker.credential_update");
		expect(first.payload.expectedRevision).toBe(1);
		harness.deliver("worker.credential_update_accepted", {
			providerId: "openai",
			accepted: true,
			currentRevision: 2,
		});
		await vi.waitFor(() => {
			expect(harness.scheduler.pendingDelays()).toContain(500);
		});
		await harness.scheduler.advanceBy(500);
		const second = await harness.waitForMessage("worker.credential_update", 2);
		expect(second.payload.expectedRevision).toBe(2);
		harness.deliver("worker.credential_update_accepted", {
			providerId: "openai",
			accepted: false,
			currentRevision: 2,
			safeReason: "credential changed concurrently",
		});
		await harness.flush();
		await harness.scheduler.advanceBy(600);
		await harness.flush();
		expect(
			harness.outgoing.filter((message) => message.type === "worker.credential_update"),
		).toHaveLength(2);
		expect(sampleCredentials).toHaveBeenCalledTimes(4);
		await harness.stop("credential_test_complete");
	});

	it("runs an already-accepted LLM start on a replacement worker", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "worker-runtime-replacement-"));
		mkdirSync(path.join(root, "workspace"), { recursive: true });
		const piFactory = new StubPiTreeHandleFactory();
		const adapters = {
			piFactory,
			gitOps: new FakeGitOps(new Map()),
			resolveWorkerProcess: () => llmProcess(),
		};
		const original = createWorkerRuntimeHarness({ adapters });
		await original.start(llmStart(root));
		const ready = await original.waitForMessage("worker.ready");
		if (ready.payload.receipt.kind !== "llm") {
			throw new Error("Expected the original worker's prepared LLM start");
		}
		original.failTransport(new Error("original worker disconnected after acceptance"));
		await original.flush();

		const replacementStart = llmStart(root);
		replacementStart.workerLeaseId = "lease_2";
		replacementStart.resume = true;
		replacementStart.acceptedPreparedStart = ready.payload.receipt.preparedStart;
		const resolvedStart = replacementStart.turnStart.state;
		if (resolvedStart.kind !== "starting") throw new Error("Expected a resolved LLM start");
		replacementStart.turnStart = {
			...replacementStart.turnStart,
			state: {
				kind: "accepted",
				start: resolvedStart.start,
				turnRecordId: "trn_1",
				acceptedWorkerLeaseId: "lease_1",
			},
		};
		const replacement = createWorkerRuntimeHarness({ adapters });
		await replacement.start(replacementStart);
		const outcome = await replacement.waitForMessage("worker.turn_outcome");
		expect(types(replacement)).not.toContain("worker.turn_started");
		expect(outcome.payload.turnRecordId).toBe("trn_1");
	});

	it("publishes lifecycle and Pi progress over IPC before extension events", async () => {
		const { harness } = createLlmHarness("worker-runtime-ordering-");
		await harness.startLlmTo("worker.turn_outcome");
		const outcomeIpc = harness.observations.findIndex(
			(item) => item.kind === "ipc" && item.type === "worker.turn_outcome",
		);
		const outcomeExtension = harness.observations.findIndex(
			(item) => item.kind === "extension" && item.event === "worker.turn_outcome",
		);
		expect(outcomeIpc).toBeGreaterThanOrEqual(0);
		expect(outcomeExtension).toBeGreaterThan(outcomeIpc);
		const piSpecific = harness.observations.findIndex(
			(item) => item.kind === "extension" && item.event === "worker.pi_event",
		);
		const genericExtension = harness.observations.findLastIndex(
			(item, index) =>
				index < piSpecific && item.kind === "extension" && item.event === "worker.event",
		);
		const progressIpc = harness.observations.findLastIndex(
			(item, index) =>
				index < genericExtension && item.kind === "ipc" && item.type === "worker.event",
		);
		expect(progressIpc).toBeGreaterThanOrEqual(0);
		expect(genericExtension).toBeGreaterThan(progressIpc);
		expect(piSpecific).toBeGreaterThan(genericExtension);
	});
});
