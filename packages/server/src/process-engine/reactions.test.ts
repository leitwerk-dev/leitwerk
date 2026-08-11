import { describe, expect, it } from "vitest";
import { createProcessOperationCoordinator } from "../process-operation-coordinator.js";
import { createDefaultTestProcessGraphRegistry } from "../test-helpers/process-fixtures.js";
import { createTestDeps } from "../test-helpers/unit-deps.js";
import { dispatchReactions } from "./reactions.js";
import type { ProcessEngineDeps, RecordedDecision } from "./types.js";

function createDeps(overrides: Partial<ProcessEngineDeps> = {}): ProcessEngineDeps {
	const deps = createTestDeps();
	return {
		...deps,
		processOperations: createProcessOperationCoordinator(),
		getSupervisor: () => undefined,
		processGraphs: createDefaultTestProcessGraphRegistry(),
		...overrides,
	};
}

function recorded(reactions: RecordedDecision["reactions"]): RecordedDecision {
	return { operationKind: "test_operation", reactions } as RecordedDecision;
}

describe("ProcessEngine reactions", () => {
	it("treats broadcast failures as non-critical", async () => {
		const deps = createDeps({
			broadcaster: {
				broadcast() {
					throw new Error("websocket unavailable");
				},
			} as never,
		});

		const result = await dispatchReactions(
			deps,
			recorded([{ kind: "broadcast", frame: { type: "process.updated", payload: {} } }]),
		);

		expect(result).toEqual({ ok: true });
	});

	it("reports best-effort broadcast failures when scheduled work requests reporting", async () => {
		const deps = createDeps({
			broadcaster: {
				broadcast() {
					throw new Error("websocket unavailable");
				},
			} as never,
		});

		const result = await dispatchReactions(
			deps,
			recorded([{ kind: "broadcast", frame: { type: "process.updated", payload: {} } }]),
			{},
			{ reportBestEffortFailures: true },
		);

		expect(result).toMatchObject({ ok: false, code: "post_commit_failed" });
	});

	it("treats worker failures as critical", async () => {
		const deps = createDeps();

		const result = await dispatchReactions(
			deps,
			recorded([{ kind: "worker", instanceId: "agt_missing", effect: { kind: "restart_worker" } }]),
		);

		expect(result).toMatchObject({ ok: false, code: "worker_reconcile_failed" });
	});

	it("treats input dispatch failures as critical", async () => {
		const deps = createDeps({
			getSupervisor: () =>
				({
					getWorker: () => undefined,
					spawnWorker: async () => {
						throw new Error("spawn failed");
					},
				}) as never,
		});
		const process = deps.processes.create({ processId: "ticket_issue_process" });
		const input = deps.inputs.create({
			instanceId: process.id,
			sequence: 1,
			source: "app_steer",
			kind: "instruction",
			bodyMarkdown: "Hello",
		});

		const result = await dispatchReactions(
			deps,
			recorded([
				{
					kind: "dispatch_inputs",
					instanceId: process.id,
					inputs: [input],
					spawnIfMissing: true,
				},
			]),
		);

		expect(result).toMatchObject({ ok: false, code: "input_dispatch_failed" });
	});

	it("logs and continues when extension event handlers fail", async () => {
		const loggedErrors: Record<string, unknown>[] = [];
		const process = createTestDeps().processes.create({ processId: "ticket_issue_process" });
		const deps = createDeps({
			extensionHost: {
				emit: async () => {
					throw new Error("extension delivery failed");
				},
			} as never,
			logger: {
				error(payload) {
					loggedErrors.push(payload);
				},
			} as never,
		});

		const result = await dispatchReactions(
			deps,
			recorded([
				{
					kind: "extension_event",
					event: {
						type: "process_created",
						payload: { instanceId: process.id, process, projects: [] },
					},
				},
			]),
		);

		expect(result).toEqual({ ok: true });
		expect(loggedErrors).toEqual([
			expect.objectContaining({
				code: "extension_event_failed",
				instanceId: process.id,
				operationKind: "test_operation",
			}),
		]);
	});

	it("emits extension events after input handling", async () => {
		const log: string[] = [];
		const deps = createDeps({
			getSupervisor: () =>
				({
					getWorker: () => ({}) as never,
					deliverInputs: () => {
						log.push("deliver_inputs");
					},
				}) as never,
			extensionHost: {
				emit: async () => {
					log.push("extension_event");
				},
			} as never,
		});
		const process = deps.processes.create({ processId: "ticket_issue_process" });
		const input = deps.inputs.create({
			instanceId: process.id,
			sequence: 1,
			source: "system",
			kind: "instruction",
			bodyMarkdown: "Hello",
		});

		const result = await dispatchReactions(
			deps,
			recorded([
				{
					kind: "dispatch_inputs",
					instanceId: process.id,
					inputs: [input],
					spawnIfMissing: true,
				},
				{ kind: "extension_event", event: { type: "process.created", payload: {} } as never },
			]),
		);

		expect(result).toEqual({ ok: true });
		expect(log).toEqual(["deliver_inputs", "extension_event"]);
	});

	it("skips direct input dispatch when a newly spawned worker will receive startup inputs", async () => {
		let spawnCalls = 0;
		let deliverCalls = 0;
		const deps = createDeps({
			getSupervisor: () =>
				({
					getWorker: () => undefined,
					spawnWorker: async () => {
						spawnCalls += 1;
						return {} as never;
					},
					deliverInputs: () => {
						deliverCalls += 1;
					},
				}) as never,
		});
		const process = deps.processes.create({ processId: "ticket_issue_process" });
		const input = deps.inputs.create({
			instanceId: process.id,
			sequence: 1,
			source: "system",
			kind: "instruction",
			bodyMarkdown: "Startup input",
		});

		const result = await dispatchReactions(
			deps,
			recorded([
				{ kind: "worker", instanceId: process.id, effect: { kind: "start_if_needed" } },
				{
					kind: "dispatch_inputs",
					instanceId: process.id,
					inputs: [input],
					spawnIfMissing: true,
				},
			]),
		);

		expect(result).toEqual({ ok: true });
		expect(spawnCalls).toBe(1);
		expect(deliverCalls).toBe(0);
	});

	it("serializes concurrent post-commit worker effects for one process", async () => {
		const calls: string[] = [];
		let releaseFirstStop!: () => void;
		const firstStop = new Promise<void>((resolve) => {
			releaseFirstStop = resolve;
		});
		let stopCalls = 0;
		const supervisor = {
			getWorker: () => ({
				kill() {
					calls.push("kill");
					releaseFirstStop();
				},
			}),
			async stopWorker(_instanceId: string, reason: string) {
				stopCalls += 1;
				calls.push(`stop:${reason}`);
				if (stopCalls === 1) await firstStop;
			},
			async spawnWorker() {
				calls.push("spawn");
				return {};
			},
		};
		const deps = createDeps({ getSupervisor: () => supervisor as never });

		const stopping = dispatchReactions(
			deps,
			recorded([
				{
					kind: "worker",
					instanceId: "agt_worker_effect_order",
					effect: { kind: "stop_with_reason", reason: "prior_turn_waiting" },
				},
			]),
		);
		await Promise.resolve();
		const restarting = dispatchReactions(
			deps,
			recorded([
				{
					kind: "worker",
					instanceId: "agt_worker_effect_order",
					effect: { kind: "restart_worker" },
				},
			]),
		);
		await Promise.resolve();

		expect(calls).toEqual(["stop:prior_turn_waiting", "kill"]);
		await expect(Promise.all([stopping, restarting])).resolves.toEqual([
			{ ok: true },
			{ ok: true },
		]);
		expect(calls).toEqual([
			"stop:prior_turn_waiting",
			"kill",
			"stop:turn_changed:restart_worker",
			"spawn",
		]);
	});
});
