import { describe, expect, it, vi } from "vitest";
import { createWrites } from "../process-engine/writes/writes.js";
import { createProcessOperationCoordinator } from "../process-operation-coordinator.js";
import { createDefaultTestProcessGraphRegistry } from "../test-helpers/process-fixtures.js";
import { createTestDeps } from "../test-helpers/unit-deps.js";
import { accept, reject } from "./decision.js";
import { defineOperation } from "./operation.js";
import { createEngineRunner } from "./runner.js";
import type { ProcessEngineDeps } from "./types.js";

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

const AcceptedNoop = defineOperation<"accepted_noop", { instanceId: string }, void>({
	kind: "accepted_noop",
	decide() {
		return accept();
	},
});

function createTestLogger() {
	return { error: vi.fn() };
}

describe("ProcessEngine runner", () => {
	it("returns a pre-record failure when the process is missing", async () => {
		const deps = createDeps();
		const run = createEngineRunner(deps);

		const result = await run(AcceptedNoop, { instanceId: "missing" });

		expect(result).toMatchObject({
			ok: false,
			code: "process_not_found",
			stage: "pre_commit",
		});
	});

	it("does not record rejected decisions", async () => {
		const base = createTestDeps();
		const process = base.processes.create({ processId: "ticket_issue_process" });
		let transactionCalls = 0;
		const deps = createDeps({
			...base,
			transaction: ((callback: Parameters<typeof base.transaction>[0]) => {
				transactionCalls += 1;
				return base.transaction(callback);
			}) as typeof base.transaction,
		});
		const Rejected = defineOperation<"rejected", { instanceId: string }, void>({
			kind: "rejected",
			decide() {
				return reject("invalid_transition", "Nope");
			},
		});
		const run = createEngineRunner(deps);

		const result = await run(Rejected, { instanceId: process.id });

		expect(result).toMatchObject({ ok: false, code: "invalid_transition" });
		expect(transactionCalls).toBe(0);
	});

	it("sanitizes unexpected decision errors and does not record them", async () => {
		const base = createTestDeps();
		const process = base.processes.create({ processId: "ticket_issue_process" });
		let transactionCalls = 0;
		const logger = createTestLogger();
		const thrown = new Error("secret provider token");
		const deps = createDeps({
			...base,
			transaction: ((callback: Parameters<typeof base.transaction>[0]) => {
				transactionCalls += 1;
				return base.transaction(callback);
			}) as typeof base.transaction,
			logger,
		});
		const Throws = defineOperation<"throws", { instanceId: string }, void>({
			kind: "throws",
			decide() {
				throw thrown;
			},
		});
		const run = createEngineRunner(deps);

		const result = await run(Throws, { instanceId: process.id });

		expect(result).toMatchObject({ ok: false, code: "operation_failed", stage: "pre_commit" });
		if (result.ok) return;
		expect(result.message).not.toContain("secret provider token");
		expect(logger.error).toHaveBeenCalledWith(
			expect.objectContaining({
				err: thrown,
				operationKind: "throws",
				instanceId: process.id,
				stage: "pre_commit",
				code: "operation_failed",
			}),
			"ProcessEngine operation failed",
		);
		expect(transactionCalls).toBe(0);
	});

	it("does not dispatch reactions when recording fails", async () => {
		const base = createTestDeps();
		const process = base.processes.create({ processId: "ticket_issue_process" });
		let spawnCalls = 0;
		const logger = createTestLogger();
		const databaseError = new Error(
			"SQLITE_BUSY: database unavailable at /private/tmp/leitwerk.sqlite\n    at Database.prepare (/repo/internal.js:10:5)",
		);
		const deps = createDeps({
			...base,
			transaction: (() => {
				throw databaseError;
			}) as typeof base.transaction,
			logger,
			getSupervisor: () =>
				({
					spawnWorker: async () => {
						spawnCalls += 1;
						return {} as never;
					},
					getWorker: () => undefined,
				}) as never,
		});
		const StartsWorker = defineOperation<"starts_worker", { instanceId: string }, void>({
			kind: "starts_worker",
			decide() {
				return accept({
					writes: { workerIntent: { kind: "start_if_needed" } },
					result: { ok: true, code: "accepted", message: "Accepted", data: undefined },
				});
			},
		});
		const run = createEngineRunner(deps);

		const result = await run(StartsWorker, { instanceId: process.id });

		expect(result).toMatchObject({ ok: false, code: "record_failed", stage: "pre_commit" });
		if (result.ok) return;
		expect(result.message).toBe("Process operation failed during durable recording");
		expect(result.message).not.toContain("SQLITE_BUSY");
		expect(result.message).not.toContain("/private/tmp/leitwerk.sqlite");
		expect(logger.error).toHaveBeenCalledWith(
			expect.objectContaining({
				err: databaseError,
				operationKind: "starts_worker",
				instanceId: process.id,
				stage: "pre_commit",
				code: "record_failed",
			}),
			"ProcessEngine operation failed",
		);
		expect(spawnCalls).toBe(0);
	});

	it("returns a post-record failure with the committed process when record finalization fails", async () => {
		const logger = createTestLogger();
		const deps = createDeps({ logger });
		const process = deps.processes.create({ processId: "ticket_issue_process" });
		const finalizationError = new Error(
			"could not derive result data from /repo/internal/finalizer.ts stack",
		);
		const FinalizationFails = defineOperation<"finalization_fails", { instanceId: string }, string>(
			{
				kind: "finalization_fails",
				decide() {
					const writes = createWrites({
						processPatch: { lifecycleStatus: "active" },
						changedFields: ["lifecycleStatus"],
					});
					return accept({
						writes,
						result: { ok: true, code: "accepted", message: "Accepted", data: "fallback" },
						deriveData() {
							throw finalizationError;
						},
					});
				},
			},
		);
		const run = createEngineRunner(deps);

		const result = await run(FinalizationFails, { instanceId: process.id });

		expect(result).toMatchObject({
			ok: false,
			code: "post_commit_failed",
			stage: "post_commit",
			process: { id: process.id, lifecycleStatus: "active" },
		});
		if (result.ok) return;
		expect(result.message).toBe("Process operation failed after commit");
		expect(result.message).not.toContain("could not derive result data");
		expect(result.message).not.toContain("/repo/internal/finalizer.ts");
		expect(logger.error).toHaveBeenCalledWith(
			expect.objectContaining({
				err: finalizationError,
				operationKind: "finalization_fails",
				instanceId: process.id,
				stage: "post_commit",
				code: "post_commit_failed",
			}),
			"ProcessEngine operation failed",
		);
		expect(deps.processes.getById(process.id)?.lifecycleStatus).toBe("active");
	});

	it("returns a post-record failure with the committed process when reactions fail", async () => {
		const logger = createTestLogger();
		const spawnError = new Error("spawn failed at /repo/internal/worker.ts");
		const deps = createDeps({
			logger,
			getSupervisor: () =>
				({
					getWorker: () => undefined,
					spawnWorker: async () => {
						throw spawnError;
					},
				}) as never,
		});
		const process = deps.processes.create({ processId: "ticket_issue_process" });
		const StartsWorker = defineOperation<"starts_worker", { instanceId: string }, void>({
			kind: "starts_worker",
			decide() {
				const writes = createWrites({ workerIntent: { kind: "start_if_needed" } });
				writes.processPatch.lifecycleStatus = "active";
				writes.changedFields.push("lifecycleStatus");
				return accept({
					writes,
					result: { ok: true, code: "accepted", message: "Accepted", data: undefined },
				});
			},
		});
		const run = createEngineRunner(deps);

		const result = await run(StartsWorker, { instanceId: process.id });

		expect(result).toMatchObject({
			ok: false,
			code: "worker_reconcile_failed",
			stage: "post_commit",
			process: { id: process.id, lifecycleStatus: "active" },
		});
		expect(logger.error).toHaveBeenCalledWith(
			expect.objectContaining({
				err: spawnError,
				operationKind: "starts_worker",
				instanceId: process.id,
				stage: "post_commit",
				code: "worker_reconcile_failed",
			}),
			"ProcessEngine operation failed",
		);
		expect(deps.processes.getById(process.id)?.lifecycleStatus).toBe("active");
	});

	it("logs and continues thrown extension event handler errors", async () => {
		const logger = createTestLogger();
		const extensionError = new Error(
			"extension handler failed at /repo/internal/extensions/secret.ts",
		);
		const deps = createDeps({
			logger,
			extensionHost: {
				on() {},
				off() {},
				emit: async () => {
					throw extensionError;
				},
			} as never,
		});
		const process = deps.processes.create({ processId: "ticket_issue_process" });
		const EmitsExtensionEvent = defineOperation<
			"emits_extension_event",
			{ instanceId: string },
			void
		>({
			kind: "emits_extension_event",
			decide() {
				return accept({
					writes: createWrites({
						extensionEvents: [
							{ type: "turn_outcome", payload: { instanceId: process.id } } as never,
						],
					}),
					result: { ok: true, code: "accepted", message: "Accepted", data: undefined },
				});
			},
		});
		const run = createEngineRunner(deps);

		const result = await run(EmitsExtensionEvent, { instanceId: process.id });

		expect(result).toMatchObject({
			ok: true,
			process: { id: process.id },
		});
		expect(logger.error).toHaveBeenCalledWith(
			expect.objectContaining({
				err: extensionError,
				operationKind: "emits_extension_event",
				instanceId: process.id,
				stage: "post_commit",
				code: "extension_event_failed",
			}),
			"ProcessEngine operation failed",
		);
	});

	it("runs after-record callbacks outside the lock and before reactions", async () => {
		const base = createTestDeps();
		const process = base.processes.create({ processId: "ticket_issue_process" });
		let locked = false;
		let observedLockedAfterRecord: boolean | null = null;
		let observedLockedDuringSpawn: boolean | null = null;
		const order: string[] = [];
		const deps = createDeps({
			...base,
			processOperations: {
				async runExclusive(_instanceId, callback) {
					locked = true;
					try {
						return await callback();
					} finally {
						locked = false;
					}
				},
			},
			getSupervisor: () =>
				({
					getWorker: () => undefined,
					spawnWorker: async () => {
						observedLockedDuringSpawn = locked;
						order.push("reaction");
						return {} as never;
					},
				}) as never,
		});
		const StartsWorker = defineOperation<"starts_worker", { instanceId: string }, void>({
			kind: "starts_worker",
			decide() {
				return accept({
					writes: { workerIntent: { kind: "start_if_needed" } },
					result: { ok: true, code: "accepted", message: "Accepted", data: undefined },
				});
			},
		});
		const run = createEngineRunner(deps);

		const result = await run(
			StartsWorker,
			{ instanceId: process.id },
			{
				afterRecord() {
					observedLockedAfterRecord = locked;
					order.push("after_record");
				},
			},
		);

		expect(result.ok).toBe(true);
		expect(observedLockedAfterRecord).toBe(false);
		expect(observedLockedDuringSpawn).toBe(false);
		expect(order).toEqual(["after_record", "reaction"]);
	});

	it("returns a post-commit failure when afterSuccess fails after a commit", async () => {
		const logger = createTestLogger();
		const deps = createDeps({ logger });
		const process = deps.processes.create({ processId: "ticket_issue_process" });
		const afterSuccessError = new Error("resolver exploded with secret details");
		const run = createEngineRunner(deps, {
			afterSuccess: async () => {
				throw afterSuccessError;
			},
		});

		const result = await run(AcceptedNoop, { instanceId: process.id });

		expect(result).toMatchObject({
			ok: false,
			code: "post_commit_failed",
			stage: "post_commit",
			process: { id: process.id },
		});
		if (result.ok) return;
		expect(result.message).toBe("Process operation failed after commit");
		expect(result.message).not.toContain("secret details");
		expect(logger.error).toHaveBeenCalledWith(
			expect.objectContaining({
				err: afterSuccessError,
				operationKind: "accepted_noop",
				instanceId: process.id,
				stage: "post_commit",
				code: "post_commit_failed",
			}),
			"ProcessEngine operation failed",
		);
	});

	it("runs afterSuccess only after successful reactions", async () => {
		const deps = createDeps();
		const process = deps.processes.create({ processId: "ticket_issue_process" });
		let afterSuccessCalls = 0;
		const run = createEngineRunner(deps, {
			afterSuccess: async () => {
				afterSuccessCalls += 1;
			},
		});

		await run(AcceptedNoop, { instanceId: process.id });

		expect(afterSuccessCalls).toBe(1);

		const failingDeps = createDeps({
			getSupervisor: () =>
				({
					getWorker: () => undefined,
					spawnWorker: async () => {
						throw new Error("spawn failed");
					},
				}) as never,
		});
		const failingProcess = failingDeps.processes.create({ processId: "ticket_issue_process" });
		let failingAfterSuccessCalls = 0;
		const failingRun = createEngineRunner(failingDeps, {
			afterSuccess: async () => {
				failingAfterSuccessCalls += 1;
			},
		});
		const StartsWorker = defineOperation<"starts_worker", { instanceId: string }, void>({
			kind: "starts_worker",
			decide() {
				return accept({
					writes: { workerIntent: { kind: "start_if_needed" } },
					result: { ok: true, code: "accepted", message: "Accepted", data: undefined },
				});
			},
		});

		await failingRun(StartsWorker, { instanceId: failingProcess.id });

		expect(failingAfterSuccessCalls).toBe(0);
	});
});
