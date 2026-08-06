import { createReviewSubject } from "@leitwerk-dev/domain";
import {
	defineProcess,
	emptyParamsCodec,
	humanTurn,
	routeTurnOutcomes,
	serverAutomaticTurn,
} from "@leitwerk-dev/process-sdk";
import { describe, expect, it } from "vitest";
import { buildProcessActionRegistry } from "./process-action-registry.js";
import { createProcessEngine } from "./process-engine/engine.js";
import { createProcessOperationCoordinator } from "./process-operation-coordinator.js";
import { createProcessGraphRegistry } from "./test-helpers/process-fixtures.js";
import { createTestDeps } from "./test-helpers/unit-deps.js";

const emptyStateCodec = {
	parse: () => ({}),
	serialize: (value: Record<string, never>) => value,
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

async function waitFor(assertion: () => boolean) {
	for (let i = 0; i < 50; i += 1) {
		if (assertion()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("Timed out waiting for assertion");
}

async function nextMacrotask(): Promise<void> {
	await new Promise((resolve) => setImmediate(resolve));
}

function createHarness(options: {
	run: () => Promise<{
		outcome: "done";
		params?: Record<string, unknown>;
		markdown?: string | null;
		state?: Record<string, never>;
	}>;
	restartBehavior?: "rerun" | "fail_running";
}) {
	const autoTurn = serverAutomaticTurn<Record<string, never>, Record<string, never>, "done">({
		description: "Server automatic",
		...(options.restartBehavior ? { restartBehavior: options.restartBehavior } : {}),
		outcomes: { done: { description: "Done", parameters: {} } },
		run: options.run,
	});
	const process = defineProcess<Record<string, never>, Record<string, never>>({
		id: "server_auto_test",
		displayName: "Server Auto Test",
		entry: "auto",
		paramsCodec: emptyParamsCodec,
		stateCodec: emptyStateCodec,
		initialState: () => ({}),
		turns: {
			auto: routeTurnOutcomes(autoTurn, {
				done: {
					to: "review",
					effect: ({ ctx }) => ({
						state: { ...ctx.state, reviewSubject: createReviewSubject("plan") },
					}),
				},
			}),
			review: humanTurn({
				description: "Review",
				reviewSubject: createReviewSubject("plan"),
				actions: {
					finish: { label: "Finish", acceptanceState: "accepted", complete: true },
					run_auto: { label: "Run auto", acceptanceState: "neutral", to: "auto" },
				},
			}),
			other: humanTurn({
				description: "Other",
				reviewSubject: createReviewSubject("plan"),
				actions: { finish: { label: "Finish", acceptanceState: "accepted", complete: true } },
			}),
		},
	});
	const processGraphs = createProcessGraphRegistry([process]);
	const deps = createTestDeps();
	const commands = createProcessEngine({
		...deps,
		processOperations: createProcessOperationCoordinator(),
		processGraphs,
		getProcessActionRegistry: () => buildProcessActionRegistry({ processes: processGraphs }),
		getSupervisor: () => undefined,
	});
	return { deps, commands };
}

type Harness = ReturnType<typeof createHarness>;

function createRunningServerAutomaticTurn(
	harness: Harness,
	options: {
		turnRecordId?: string;
		status?: "running" | "succeeded" | "failed";
	} = {},
) {
	const process = harness.deps.processes.create({
		processId: "server_auto_test",
		selectedTurnId: "auto",
		lifecycleStatus: "active",
	});
	const turnRecordId = options.turnRecordId ?? "trn_running_server_auto";
	const turnRecord = harness.deps.turnRecords.create({
		id: turnRecordId,
		instanceId: process.id,
		turnId: "auto",
		turnType: "server_automatic",
		status: options.status ?? "running",
		pathType: "primary",
	});
	harness.deps.processes.update(process.id, {
		currentExecution: { kind: "server_turn", id: turnRecord.id },
	});
	const updated = harness.deps.processes.getById(process.id);
	if (!updated) throw new Error("expected server-automatic process");
	return { process: updated, turnRecord };
}

type NonBlockingImplicitDrainScenario = {
	createProcess(harness: Harness): string;
	execute(harness: Harness, instanceId: string): Promise<{ ok: boolean }>;
	blockingMessage: string;
};

async function expectImplicitDrainDoesNotWait(
	scenario: NonBlockingImplicitDrainScenario,
): Promise<void> {
	const result = deferred<{ outcome: "done"; params: Record<string, never> }>();
	let runStarted = false;
	const harness = createHarness({
		run: () => {
			runStarted = true;
			return result.promise;
		},
	});
	const instanceId = scenario.createProcess(harness);

	let completed: { settled: false } | { settled: true; value: { ok: boolean } } = {
		settled: false,
	};
	const execution = scenario.execute(harness, instanceId).then((value) => {
		completed = { settled: true, value };
		return value;
	});
	await waitFor(() => runStarted);
	await nextMacrotask();
	expect(completed.settled).toBe(true);
	if (!completed.settled) {
		result.resolve({ outcome: "done", params: {} });
		await execution;
		throw new Error(scenario.blockingMessage);
	}
	expect(completed.value.ok).toBe(true);
	expect(harness.deps.processes.getById(instanceId)).toMatchObject({
		selectedTurnId: "auto",
		lifecycleStatus: "active",
	});
	await waitFor(() =>
		harness.deps.turnRecords
			.listByInstance(instanceId)
			.some((record) => record.turnId === "auto" && record.status === "running"),
	);
	const running = harness.deps.turnRecords
		.listByInstance(instanceId)
		.find((record) => record.turnId === "auto" && record.status === "running");
	expect(harness.deps.processes.getById(instanceId)?.currentExecution).toEqual({
		kind: "server_turn",
		id: running?.id,
	});

	result.resolve({ outcome: "done", params: {} });
	await waitFor(() => harness.deps.processes.getById(instanceId)?.selectedTurnId === "review");
}

describe("server-automatic drain concurrency", () => {
	it("does not wait for implicit drain when starting a server-automatic turn", () =>
		expectImplicitDrainDoesNotWait({
			createProcess: (harness) =>
				harness.deps.processes.create({
					processId: "server_auto_test",
					selectedTurnId: null,
					lifecycleStatus: "discovered",
				}).id,
			execute: (harness, instanceId) => harness.commands.startProcess(instanceId, "auto"),
			blockingMessage: "startProcess waited for the server-automatic run to finish",
		}));

	it("does not wait for implicit drain after an action selects a server-automatic turn", () =>
		expectImplicitDrainDoesNotWait({
			createProcess: (harness) =>
				harness.deps.processes.create({
					processId: "server_auto_test",
					selectedTurnId: "review",
					lifecycleStatus: "waiting",
					stateJson: JSON.stringify({ reviewSubject: createReviewSubject("plan") }),
				}).id,
			execute: (harness, instanceId) =>
				harness.commands.executeProcessAction(instanceId, "run_auto", {}),
			blockingMessage: "executeProcessAction waited for the server-automatic run to finish",
		}));

	it("runs a fresh non-replayable server-automatic turn exactly once", async () => {
		let runs = 0;
		const harness = createHarness({
			restartBehavior: "fail_running",
			run: async () => {
				runs += 1;
				return { outcome: "done", params: {} };
			},
		});
		const process = harness.deps.processes.create({
			processId: "server_auto_test",
			selectedTurnId: null,
			lifecycleStatus: "discovered",
		});

		const started = await harness.commands.startProcess(process.id, "auto");

		expect(started.ok).toBe(true);
		await waitFor(() => harness.deps.processes.getById(process.id)?.selectedTurnId === "review");
		expect(runs).toBe(1);
		expect(harness.deps.turnRecords.listByInstance(process.id)).toEqual([
			expect.objectContaining({
				turnId: "auto",
				turnType: "server_automatic",
				status: "succeeded",
			}),
		]);
	});

	it("drains different instances independently", async () => {
		const runs: string[] = [];
		const first = deferred<{ outcome: "done"; params: Record<string, never> }>();
		const second = deferred<{ outcome: "done"; params: Record<string, never> }>();
		const harness = createHarness({
			run: () => {
				const index = runs.length;
				runs.push(index === 0 ? "first" : "second");
				return index === 0 ? first.promise : second.promise;
			},
		});
		const { process: a } = createRunningServerAutomaticTurn(harness, {
			turnRecordId: "trn_server_auto_a",
		});
		const { process: b } = createRunningServerAutomaticTurn(harness, {
			turnRecordId: "trn_server_auto_b",
		});

		const drainA = harness.commands.drainServerAutomaticTurns(a.id);
		const drainB = harness.commands.drainServerAutomaticTurns(b.id);
		await waitFor(() => runs.length === 2);
		first.resolve({ outcome: "done", params: {} });
		second.resolve({ outcome: "done", params: {} });
		await Promise.all([drainA, drainB]);

		expect(harness.deps.processes.getById(a.id)).toMatchObject({
			selectedTurnId: "review",
			lifecycleStatus: "waiting",
		});
		expect(harness.deps.processes.getById(b.id)).toMatchObject({
			selectedTurnId: "review",
			lifecycleStatus: "waiting",
		});
	});

	it("coalesces concurrent drains for the same instance", async () => {
		let runs = 0;
		const result = deferred<{ outcome: "done"; params: Record<string, never> }>();
		const harness = createHarness({
			run: () => {
				runs += 1;
				return result.promise;
			},
		});
		const { process } = createRunningServerAutomaticTurn(harness);

		const first = harness.commands.drainServerAutomaticTurns(process.id);
		const second = harness.commands.drainServerAutomaticTurns(process.id);
		await waitFor(() => runs === 1);
		result.resolve({ outcome: "done", params: {} });
		await Promise.all([first, second]);

		expect(runs).toBe(1);
		expect(harness.deps.turnRecords.listByInstance(process.id)).toHaveLength(1);
	});

	it("resumes an already-started server-automatic turn record", async () => {
		let runs = 0;
		const harness = createHarness({
			run: async () => {
				runs += 1;
				return { outcome: "done", params: {} };
			},
		});
		const { process } = createRunningServerAutomaticTurn(harness);

		await harness.commands.drainServerAutomaticTurns(process.id);

		expect(runs).toBe(1);
		expect(harness.deps.turnRecords.listByInstance(process.id)).toMatchObject([
			{
				id: "trn_running_server_auto",
				turnId: "auto",
				turnType: "server_automatic",
				status: "succeeded",
			},
		]);
		expect(harness.deps.processes.getById(process.id)).toMatchObject({
			selectedTurnId: "review",
			lifecycleStatus: "waiting",
			currentExecution: null,
		});
	});

	it("fails an already-started server-automatic turn record when rerun is disabled", async () => {
		let runs = 0;
		const harness = createHarness({
			restartBehavior: "fail_running",
			run: async () => {
				runs += 1;
				return { outcome: "done", params: {} };
			},
		});
		const { process } = createRunningServerAutomaticTurn(harness, {
			turnRecordId: "trn_non_replayable_server_auto",
		});

		await harness.commands.drainServerAutomaticTurns(process.id);

		expect(runs).toBe(0);
		expect(harness.deps.processes.getById(process.id)).toMatchObject({
			selectedTurnId: "auto",
			lifecycleStatus: "error",
			currentExecution: { kind: "server_turn", id: "trn_non_replayable_server_auto" },
		});
		expect(harness.deps.turnRecords.getById("trn_non_replayable_server_auto")).toMatchObject({
			id: "trn_non_replayable_server_auto",
			turnId: "auto",
			turnType: "server_automatic",
			status: "failed",
			errorClass: "infrastructure",
		});
	});

	it("fails an already-started server-automatic turn record when the resumed handler fails", async () => {
		const harness = createHarness({
			run: async () => {
				throw new Error("resume failed");
			},
		});
		const { process } = createRunningServerAutomaticTurn(harness, {
			turnRecordId: "trn_running_server_auto_failed",
		});

		await harness.commands.drainServerAutomaticTurns(process.id);

		expect(harness.deps.processes.getById(process.id)).toMatchObject({
			selectedTurnId: "auto",
			lifecycleStatus: "error",
			currentExecution: { kind: "server_turn", id: "trn_running_server_auto_failed" },
		});
		expect(harness.deps.turnRecords.getById("trn_running_server_auto_failed")).toMatchObject({
			id: "trn_running_server_auto_failed",
			turnId: "auto",
			turnType: "server_automatic",
			status: "failed",
			errorSummary: "resume failed",
			errorClass: "infrastructure",
		});
	});

	it("parks active server-automatic turns when the current turn record cannot be resumed", async () => {
		let runs = 0;
		const harness = createHarness({
			run: async () => {
				runs += 1;
				return { outcome: "done", params: {} };
			},
		});
		const { process } = createRunningServerAutomaticTurn(harness, {
			turnRecordId: "trn_finished_server_auto",
			status: "succeeded",
		});

		await harness.commands.drainServerAutomaticTurns(process.id);

		expect(runs).toBe(0);
		expect(harness.deps.processes.getById(process.id)).toMatchObject({
			selectedTurnId: "auto",
			lifecycleStatus: "error",
			currentExecution: { kind: "server_turn", id: "trn_finished_server_auto" },
		});
		expect(harness.deps.turnRecords.getById("trn_finished_server_auto")).toMatchObject({
			status: "succeeded",
		});
		expect(
			harness.deps.events
				.listByInstance(process.id)
				.some((event) => event.eventType === "lifecycle_parked"),
		).toBe(true);
	});

	it("fails an already-started server-automatic turn record when outcome recording rejects a non-stale result", async () => {
		const harness = createHarness({
			run: async () => ({ outcome: "done", params: { unexpected: "value" } }),
		});
		const { process } = createRunningServerAutomaticTurn(harness, {
			turnRecordId: "trn_running_server_auto_invalid_result",
		});

		await harness.commands.drainServerAutomaticTurns(process.id);

		expect(harness.deps.turnRecords.listByInstance(process.id)).toHaveLength(1);
		expect(
			harness.deps.turnRecords.getById("trn_running_server_auto_invalid_result"),
		).toMatchObject({
			id: "trn_running_server_auto_invalid_result",
			turnId: "auto",
			turnType: "server_automatic",
			status: "failed",
			errorClass: "infrastructure",
		});
		const failedTurnRecord = harness.deps.turnRecords.getById(
			"trn_running_server_auto_invalid_result",
		);
		expect(typeof failedTurnRecord?.errorSummary).toBe("string");
		expect(failedTurnRecord?.errorSummary?.trim()).not.toBe("");
		expect(harness.deps.processes.getById(process.id)).toMatchObject({
			selectedTurnId: "auto",
			lifecycleStatus: "error",
			currentExecution: { kind: "server_turn", id: "trn_running_server_auto_invalid_result" },
		});
	});

	it("does not fail a server-automatic turn when outcome recording is stale after the selected turn changed", async () => {
		const result = deferred<{ outcome: "done"; params: Record<string, never> }>();
		const harness = createHarness({ run: () => result.promise });
		const { process } = createRunningServerAutomaticTurn(harness);

		const drain = harness.commands.drainServerAutomaticTurns(process.id);
		await waitFor(() => harness.deps.turnRecords.listByInstance(process.id).length === 1);
		const turnRecordId = harness.deps.turnRecords.listByInstance(process.id)[0]?.id;
		if (!turnRecordId) {
			throw new Error("expected server-automatic turn record");
		}
		harness.deps.processes.update(process.id, {
			selectedTurnId: "other",
			lifecycleStatus: "waiting",
			currentExecution: null,
		});
		result.resolve({ outcome: "done", params: {} });
		await drain;

		expect(harness.deps.processes.getById(process.id)).toMatchObject({
			selectedTurnId: "other",
			lifecycleStatus: "waiting",
			currentExecution: null,
		});
		expect(harness.deps.turnRecords.getById(turnRecordId)).toMatchObject({
			id: turnRecordId,
			turnId: "auto",
			turnType: "server_automatic",
			status: "running",
		});
	});

	it("direct selection atomically creates the running server-turn execution", async () => {
		const result = deferred<{ outcome: "done"; params: Record<string, never> }>();
		const harness = createHarness({ run: () => result.promise });
		const process = harness.deps.processes.create({
			processId: "server_auto_test",
			selectedTurnId: null,
			lifecycleStatus: "discovered",
		});

		const selected = await harness.commands.startProcess(process.id, "auto");
		expect(selected.ok).toBe(true);
		await waitFor(() => harness.deps.turnRecords.listByInstance(process.id).length === 1);
		const [turnRecord] = harness.deps.turnRecords.listByInstance(process.id);
		expect(turnRecord).toMatchObject({
			instanceId: process.id,
			turnId: "auto",
			turnType: "server_automatic",
			status: "running",
		});
		expect(harness.deps.processes.getById(process.id)?.currentExecution).toEqual({
			kind: "server_turn",
			id: turnRecord?.id,
		});

		result.resolve({ outcome: "done", params: {} });
		await waitFor(() => harness.deps.processes.getById(process.id)?.selectedTurnId === "review");
	});

	it("keeps abort durable when an in-flight server-automatic outcome arrives", async () => {
		const result = deferred<{ outcome: "done"; params: Record<string, never> }>();
		const harness = createHarness({ run: () => result.promise });
		const { process } = createRunningServerAutomaticTurn(harness);

		const drain = harness.commands.drainServerAutomaticTurns(process.id);
		await waitFor(() => harness.deps.turnRecords.listByInstance(process.id).length === 1);
		await harness.commands.abortProcess(process.id);
		result.resolve({ outcome: "done", params: {} });
		await drain;

		expect(harness.deps.processes.getById(process.id)).toMatchObject({
			lifecycleStatus: "aborted",
		});
	});

	it("keeps a newer selected turn when an in-flight server-automatic outcome arrives", async () => {
		const result = deferred<{ outcome: "done"; params: Record<string, never> }>();
		const harness = createHarness({ run: () => result.promise });
		const { process } = createRunningServerAutomaticTurn(harness);

		const drain = harness.commands.drainServerAutomaticTurns(process.id);
		await waitFor(() => harness.deps.turnRecords.listByInstance(process.id).length === 1);
		harness.deps.processes.update(process.id, {
			selectedTurnId: "other",
			lifecycleStatus: "waiting",
			currentExecution: null,
		});
		result.resolve({ outcome: "done", params: {} });
		await drain;

		expect(harness.deps.processes.getById(process.id)).toMatchObject({
			lifecycleStatus: "waiting",
			selectedTurnId: "other",
		});
	});
});
