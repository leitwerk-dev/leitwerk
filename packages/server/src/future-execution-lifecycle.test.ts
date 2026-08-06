import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ADMIN_ACTOR, type ProcessInstance, SYSTEM_ACTOR } from "@leitwerk-dev/domain";
import {
	parseFutureActionPayloadJson,
	parseFutureLaunchPayloadJson,
	serializeFutureActionPayload,
	serializeFutureLaunchPayload,
} from "@leitwerk-dev/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDefaultConfig } from "./config/config-loader.js";
import { closeDatabase } from "./db/database.js";
import { createFutureExecutionLifecycle } from "./future-execution/index.js";
import type { ProcessActionRegistry } from "./process-action-registry.js";
import { createProcessEngine } from "./process-engine/engine.js";
import type { ProcessEngine } from "./process-engine/types.js";
import { createServerProcessModelPolicy } from "./process-model-policy/index.js";
import { createProcessOperationCoordinator } from "./process-operation-coordinator.js";
import { createDefaultTestProcessGraphRegistry } from "./test-helpers/process-fixtures.js";
import { createTestLaunchPlan } from "./test-helpers/process-model-fixtures.js";
import { createTestDeps } from "./test-helpers/unit-deps.js";

const testDatabases: Array<{ db: ReturnType<typeof createTestDeps>["db"]; root: string }> = [];

afterEach(() => {
	for (const fixture of testDatabases.splice(0)) {
		closeDatabase(fixture.db);
		rmSync(fixture.root, { recursive: true, force: true });
	}
});

function createServiceHarness(
	options: {
		commands?: ProcessEngine;
		extensionHost?: Parameters<typeof createFutureExecutionLifecycle>[0]["extensionHost"];
		launcherRecentValues?: Parameters<
			typeof createFutureExecutionLifecycle
		>[0]["launcherRecentValues"];
		launchPlans?: Parameters<typeof createFutureExecutionLifecycle>[0]["launchPlans"];
		processActionRegistry?: ProcessActionRegistry;
		startTurnId?: string | null;
		failTitleQueue?: boolean;
		failProcessTitleQueue?: boolean;
	} = {},
) {
	const root = mkdtempSync(path.join(tmpdir(), "leitwerk-future-lifecycle-"));
	const deps = createTestDeps({ sqlitePath: path.join(root, "leitwerk.db") });
	testDatabases.push({ db: deps.db, root });
	const processOperations = createProcessOperationCoordinator();
	const processGraphs = createDefaultTestProcessGraphRegistry();
	const processModelPolicy = createServerProcessModelPolicy({
		config: getDefaultConfig(),
		processGraphs,
		processActionRegistry: { getTurnDefinition: () => undefined },
	});
	const modelStatusCache = {
		snapshot: () => ({
			revision: 1,
			capturedAt: "2026-01-01T00:00:00.000Z",
			availabilityTransitions: [],
			profiles: [],
		}),
	};
	const commands =
		options.commands ??
		createProcessEngine({
			...deps,
			processOperations,
			getSupervisor: () => undefined,
			processGraphs,
		});
	const launcherService = {
		async resolveUiLauncher() {
			return {
				ok: true as const,
				launcher: {
					processId: "jira_issue_process",
					launcherId: "demo.launcher",
					launchPlan: createTestLaunchPlan({
						launcherId: "demo.launcher",
						processId: "jira_issue_process",
						startTurnId: options.startTurnId ?? null,
						processInput: {
							processId: "jira_issue_process",
							selectedTurnId: null,
							paramsJson: "{}",
							stateJson: "{}",
						},
					}),
				},
			};
		},
		listUiLaunchers() {
			return [];
		},
	};
	const service = createFutureExecutionLifecycle({
		...deps,
		broadcaster: deps.broadcaster,
		commands,
		processOperations,
		launcherService: launcherService as never,
		launcherRecentValues: options.launcherRecentValues,
		launchPlans: options.launchPlans ?? deps.launchPlans,
		processGraphs,
		processActionRegistry: options.processActionRegistry,
		extensionHost: options.extensionHost,
		processModelPolicy,
		modelStatusCache,
		processTitles: {
			queueProcessTitleGeneration() {
				if (options.failProcessTitleQueue) throw new Error("process title queue unavailable");
			},
			queueFutureExecutionTitleGeneration() {
				if (options.failTitleQueue) throw new Error("title queue unavailable");
			},
		},
	});
	return { deps, service };
}

function createSchedulableActionRegistry(): ProcessActionRegistry {
	const action = {
		id: "approve_plan",
		label: "Approve plan",
		async plan() {},
	};
	return {
		getAction: () => action,
		isTurnScopedAction: () => false,
		listVisibleActions: () => [],
		getSelectedTurnSummary: () => null,
		getServerDefinition: () => undefined,
		getTurnDefinition: () => undefined,
		getProcessGraph: () => undefined,
		getProcessDisplayName: () => undefined,
		resolveContextData: () => ({ params: {}, state: {} }),
		resolveTurnScopedAction: () => null,
		resolveActionPreview: () => null,
		resolveActionScheduling: () => ({
			definition: { label: "Approve plan" },
			candidateSelectedTurnId: null,
			lifecycleStatus: null,
		}),
	};
}

function createDueLaunch(
	deps: ReturnType<typeof createTestDeps>,
	overrides: Partial<Parameters<typeof deps.futureExecutions.create>[0]> = {},
) {
	const launchPlan = createTestLaunchPlan({
		launcherId: "demo.launcher",
		processId: "jira_issue_process",
		startTurnId: null,
		processInput: {
			processId: "jira_issue_process",
			selectedTurnId: null,
			paramsJson: "{}",
			stateJson: "{}",
		},
	});
	return deps.futureExecutions.create({
		kind: "launch",
		scheduleKind: "once",
		processId: launchPlan.processId,
		launcherId: launchPlan.launcherId,
		payloadJson: serializeFutureLaunchPayload({
			launcherInput: {},
			modelConfig: {},
			launchPlan,
		}),
		nextRunAt: "2027-04-25T09:00:00.000Z",
		...overrides,
	});
}

function createDueAction(
	deps: ReturnType<typeof createTestDeps>,
	process: ProcessInstance,
	overrides: Partial<Parameters<typeof deps.futureExecutions.create>[0]> = {},
) {
	return deps.futureExecutions.create({
		kind: "action",
		scheduleKind: "once",
		processId: process.processId,
		instanceId: process.id,
		actionId: "approve_plan",
		payloadJson: serializeFutureActionPayload({
			input: { approved: true },
			nextTurnModelProfileId: null,
			actionLabel: "Approve plan",
		}),
		nextRunAt: "2027-04-25T09:00:00.000Z",
		...overrides,
	});
}

describe("FutureExecutionLifecycle", () => {
	it("emits process-created extension events for launch-now requests", async () => {
		const emittedEvents: string[] = [];
		const { service } = createServiceHarness({
			extensionHost: {
				on() {},
				off() {},
				emit: async (event) => {
					emittedEvents.push(event);
				},
			},
		});

		const result = await service.scheduleLaunch("demo.launcher", {
			title: null,
			titleProvided: false,
			launcherInput: {},
			launcherInputProvided: true,
			modelConfig: {},
			modelConfigProvided: false,
			schedule: { mode: "now" },
			scheduleProvided: true,
		});

		expect(result.kind).toBe("launched");
		expect(emittedEvents).toContain("process_created");
	});

	it("records launcher recent values after successful launch-now requests", async () => {
		const recorded: Array<{ launcherId: string; launcherInput: Record<string, unknown> }> = [];
		const { service } = createServiceHarness({
			launcherRecentValues: {
				list: () => ({}),
				record: (launcherId, launcherInput) => recorded.push({ launcherId, launcherInput }),
			},
		});

		const result = await service.scheduleLaunch("demo.launcher", {
			title: null,
			titleProvided: false,
			launcherInput: { repoLocator: "/tmp/repo" },
			launcherInputProvided: true,
			modelConfig: {},
			modelConfigProvided: false,
			schedule: { mode: "now" },
			scheduleProvided: true,
		});

		expect(result.kind).toBe("launched");
		expect(recorded).toEqual([
			{ launcherId: "demo.launcher", launcherInput: { repoLocator: "/tmp/repo" } },
		]);
	});

	it("attests scheduled launches to the caller actor", async () => {
		const { deps, service } = createServiceHarness();

		const result = await service.scheduleLaunch(
			"demo.launcher",
			{
				title: null,
				titleProvided: false,
				launcherInput: {},
				launcherInputProvided: true,
				modelConfig: {},
				modelConfigProvided: false,
				schedule: { mode: "once", runAt: "2027-04-25T09:00:00.000Z" },
				scheduleProvided: true,
			},
			{ actor: ADMIN_ACTOR },
		);

		expect(result.kind).toBe("scheduled");
		const parsed = parseFutureLaunchPayloadJson(
			deps.futureExecutions.listAll()[0]?.payloadJson ?? "",
		);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value.actor).toEqual(ADMIN_ACTOR);
	});

	it("reports scheduled-launch creation committed with a reaction error", async () => {
		const { deps, service } = createServiceHarness({ failTitleQueue: true });
		deps.broadcaster.broadcast = () => {
			throw new Error("broadcast unavailable");
		};

		const result = await service.scheduleLaunch("demo.launcher", {
			title: null,
			titleProvided: false,
			launcherInput: {},
			launcherInputProvided: true,
			modelConfig: {},
			modelConfigProvided: false,
			schedule: { mode: "once", runAt: "2027-04-25T09:00:00.000Z" },
			scheduleProvided: true,
		});

		expect(result).toMatchObject({
			kind: "committed_with_reaction_error",
			code: "broadcast_failed",
		});
		expect(deps.futureExecutions.listAll()).toHaveLength(1);
		expect(deps.futureExecutions.listAll()[0]).toMatchObject({
			kind: "launch",
			nextRunAt: "2027-04-25T09:00:00.000Z",
		});
	});

	it("reports cancellation committed with a reaction error", async () => {
		const { deps, service } = createServiceHarness();
		const execution = deps.futureExecutions.create({
			kind: "launch",
			scheduleKind: "once",
			processId: "jira_issue_process",
			launcherId: "demo.launcher",
			payloadJson: JSON.stringify({}),
			nextRunAt: "2027-04-25T09:00:00.000Z",
		});
		deps.broadcaster.broadcast = () => {
			throw new Error("broadcast unavailable");
		};

		const result = await service.cancel(execution.id);

		expect(result).toMatchObject({
			kind: "committed_with_reaction_error",
			code: "broadcast_failed",
		});
		expect(deps.futureExecutions.getById(execution.id)).toBeNull();
	});

	it("keeps a scheduled action when execute-now fails before commit", async () => {
		const commandState: { process?: ProcessInstance } = {};
		const { deps, service } = createServiceHarness({
			commands: {
				async executeProcessAction() {
					if (!commandState.process) {
						throw new Error("test process was not initialized");
					}
					return {
						ok: false,
						stage: "pre_commit",
						process: commandState.process,
						error: "transient action failure",
						code: "worker_unavailable",
					} as never;
				},
			} as ProcessEngine,
		});
		const process = deps.processes.create({ processId: "jira_issue_process" });
		commandState.process = process;
		const execution = deps.futureExecutions.create({
			kind: "action",
			scheduleKind: "once",
			processId: process.processId,
			instanceId: process.id,
			actionId: "approve_plan",
			payloadJson: serializeFutureActionPayload({
				input: {},
				nextTurnModelProfileId: null,
				actionLabel: "Approve plan",
			}),
			nextRunAt: "2027-04-25T09:00:00.000Z",
		});

		const result = await service.reviseScheduledAction(execution.id, {
			input: {},
			inputProvided: true,
			nextTurnModelProfileIdProvided: false,
			schedule: { mode: "now" },
			scheduleProvided: true,
		});

		expect(result.kind).toBe("invalid");
		expect(deps.futureExecutions.getById(execution.id)).toMatchObject({ id: execution.id });
	});

	it("attributes update-to-now scheduled actions to the caller actor", async () => {
		const executeProcessAction = vi.fn();
		const commandState: { process?: ProcessInstance } = {};
		const { deps, service } = createServiceHarness({
			commands: {
				async executeProcessAction(instanceId, actionId, input, opts) {
					executeProcessAction(instanceId, actionId, input, opts);
					if (!commandState.process) {
						throw new Error("test process was not initialized");
					}
					return { ok: true, process: commandState.process, data: {} };
				},
			} as ProcessEngine,
		});
		const process = deps.processes.create({ processId: "jira_issue_process" });
		commandState.process = process;
		const execution = deps.futureExecutions.create({
			kind: "action",
			scheduleKind: "once",
			processId: process.processId,
			instanceId: process.id,
			actionId: "approve_plan",
			payloadJson: serializeFutureActionPayload({
				input: {},
				nextTurnModelProfileId: null,
				actionLabel: "Approve plan",
			}),
			nextRunAt: "2027-04-25T09:00:00.000Z",
		});

		const result = await service.reviseScheduledAction(
			execution.id,
			{
				input: {},
				inputProvided: true,
				nextTurnModelProfileIdProvided: false,
				schedule: { mode: "now" },
				scheduleProvided: true,
			},
			{ actor: ADMIN_ACTOR },
		);

		expect(result.kind).toBe("executed");
		expect(executeProcessAction).toHaveBeenCalledWith(
			process.id,
			"approve_plan",
			{},
			expect.objectContaining({ actor: ADMIN_ACTOR }),
		);
	});

	it("repairs an invalid scheduled action payload when all payload fields are replaced", async () => {
		const { deps, service } = createServiceHarness({
			processActionRegistry: createSchedulableActionRegistry(),
		});
		const process = deps.processes.create({ processId: "jira_issue_process" });
		const execution = deps.futureExecutions.create({
			kind: "action",
			scheduleKind: "once",
			processId: process.processId,
			instanceId: process.id,
			actionId: "approve_plan",
			payloadJson: "{not valid json",
			nextRunAt: "2027-04-25T09:00:00.000Z",
		});

		const result = await service.reviseScheduledAction(execution.id, {
			input: { approved: true },
			inputProvided: true,
			nextTurnModelProfileId: null,
			nextTurnModelProfileIdProvided: true,
			schedule: { mode: "once", runAt: "2027-04-25T10:00:00.000Z" },
			scheduleProvided: true,
		});

		expect(result.kind).toBe("scheduled");
		const updated = deps.futureExecutions.getById(execution.id);
		expect(updated?.nextRunAt).toBe("2027-04-25T10:00:00.000Z");
		const parsed = parseFutureActionPayloadJson(updated?.payloadJson ?? "");
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value.input).toEqual({ approved: true });
		expect(parsed.value.nextTurnModelProfileId).toBeNull();
		expect(parsed.value.actor).toEqual(SYSTEM_ACTOR);
	});

	it("relies on ProcessEngine consumption when execute-now fails after commit", async () => {
		const commandState: { process?: ProcessInstance } = {};
		let consumeScheduledExecution = () => {
			throw new Error("test scheduled execution was not initialized");
		};
		const { deps, service } = createServiceHarness({
			commands: {
				async executeProcessAction() {
					if (!commandState.process) {
						throw new Error("test process was not initialized");
					}
					consumeScheduledExecution();
					return {
						ok: false,
						stage: "post_commit",
						process: commandState.process,
						error: "post-commit action failure",
						code: "worker_reconcile_failed",
					};
				},
			} as ProcessEngine,
		});
		const process = deps.processes.create({ processId: "jira_issue_process" });
		commandState.process = process;
		const execution = deps.futureExecutions.create({
			kind: "action",
			scheduleKind: "once",
			processId: process.processId,
			instanceId: process.id,
			actionId: "approve_plan",
			payloadJson: serializeFutureActionPayload({
				input: {},
				nextTurnModelProfileId: null,
				actionLabel: "Approve plan",
			}),
			nextRunAt: "2027-04-25T09:00:00.000Z",
		});
		const deleteExecution = vi.spyOn(deps.futureExecutions, "delete");
		consumeScheduledExecution = () => {
			deps.futureExecutions.delete(execution.id);
		};

		const result = await service.reviseScheduledAction(execution.id, {
			input: {},
			inputProvided: true,
			nextTurnModelProfileIdProvided: false,
			schedule: { mode: "now" },
			scheduleProvided: true,
		});

		expect(result).toMatchObject({
			kind: "committed_with_reaction_error",
			process,
			error: "post-commit action failure",
		});
		expect(deps.futureExecutions.getById(execution.id)).toBeNull();
		expect(deleteExecution).toHaveBeenCalledTimes(1);
	});

	it("schedules a one-time retry after a transient due-action failure", async () => {
		const commandState: { process?: ProcessInstance } = {};
		const { deps, service } = createServiceHarness({
			commands: {
				async executeProcessAction() {
					if (!commandState.process) throw new Error("Expected process");
					return {
						ok: false,
						stage: "pre_commit",
						process: commandState.process,
						error: "temporarily unavailable",
						code: "worker_unavailable",
					} as never;
				},
			} as ProcessEngine,
		});
		const process = deps.processes.create({ processId: "jira_issue_process" });
		commandState.process = process;
		const execution = deps.futureExecutions.create({
			kind: "action",
			scheduleKind: "once",
			processId: process.processId,
			instanceId: process.id,
			actionId: "approve_plan",
			payloadJson: serializeFutureActionPayload({
				input: {},
				nextTurnModelProfileId: null,
				actionLabel: "Approve plan",
			}),
			nextRunAt: "2027-04-25T09:00:00.000Z",
		});

		const result = await service.runDueWork("2027-04-25T09:00:00.000Z");

		expect(result.items).toContainEqual({
			futureExecutionId: execution.id,
			kind: "retry_scheduled",
		});
		expect(deps.futureExecutions.getById(execution.id)?.nextRunAt).toBe("2027-04-25T09:01:00.000Z");
	});

	it("removes a terminally invalid due action", async () => {
		const commandState: { process?: ProcessInstance } = {};
		const { deps, service } = createServiceHarness({
			commands: {
				async executeProcessAction() {
					if (!commandState.process) throw new Error("Expected process");
					return {
						ok: false,
						stage: "pre_commit",
						process: commandState.process,
						error: "Action not found",
						code: "action_not_found",
					} as never;
				},
			} as ProcessEngine,
		});
		const process = deps.processes.create({ processId: "jira_issue_process" });
		commandState.process = process;
		const execution = deps.futureExecutions.create({
			kind: "action",
			scheduleKind: "once",
			processId: process.processId,
			instanceId: process.id,
			actionId: "removed_action",
			payloadJson: serializeFutureActionPayload({
				input: {},
				nextTurnModelProfileId: null,
				actionLabel: "Removed action",
			}),
			nextRunAt: "2027-04-25T09:00:00.000Z",
		});

		const result = await service.runDueWork("2027-04-25T09:00:00.000Z");

		expect(result.items).toContainEqual({
			futureExecutionId: execution.id,
			kind: "terminal_invalid_removed",
		});
		expect(deps.futureExecutions.getById(execution.id)).toBeNull();
	});

	it("reports committed launch work when update-to-now startup fails", async () => {
		const { deps, service } = createServiceHarness({
			startTurnId: "run",
			commands: {
				async startProcess() {
					return {
						ok: false,
						stage: "post_commit",
						code: "worker_reconcile_failed",
						message: "worker startup failed",
					};
				},
			} as ProcessEngine,
		});
		const launchPlan = createTestLaunchPlan({
			launcherId: "demo.launcher",
			processId: "jira_issue_process",
			startTurnId: "run",
			processInput: {
				processId: "jira_issue_process",
				selectedTurnId: null,
				paramsJson: "{}",
				stateJson: "{}",
			},
		});
		const execution = deps.futureExecutions.create({
			kind: "launch",
			scheduleKind: "once",
			processId: launchPlan.processId,
			launcherId: launchPlan.launcherId,
			payloadJson: serializeFutureLaunchPayload({
				launcherInput: {},
				modelConfig: {},
				launchPlan,
			}),
			nextRunAt: "2027-04-25T09:00:00.000Z",
		});

		const outcome = await service.reviseScheduledLaunch(execution.id, {
			title: null,
			titleProvided: true,
			launcherInput: {},
			launcherInputProvided: true,
			modelConfig: {},
			modelConfigProvided: true,
			schedule: { mode: "now" },
			scheduleProvided: true,
		});

		expect(outcome).toMatchObject({
			kind: "committed_with_reaction_error",
			error: "Process was created, but the worker could not be started cleanly",
		});
		expect(deps.processes.listAll()).toHaveLength(1);
		expect(deps.futureExecutions.getById(execution.id)).toBeNull();
	});

	it.each([
		"launch",
		"action",
	] as const)("commits and consumes successful one-time due %s work", async (kind) => {
		const commandState: { process?: ProcessInstance } = {};
		let consumeScheduledAction = () => undefined;
		const executeProcessAction = vi.fn(async () => {
			consumeScheduledAction();
			return {
				ok: true as const,
				process: commandState.process ?? null,
				data: {},
			};
		});
		const { deps, service } = createServiceHarness({
			...(kind === "action"
				? { commands: { executeProcessAction } as unknown as ProcessEngine }
				: {}),
		});
		const execution =
			kind === "launch"
				? createDueLaunch(deps)
				: (() => {
						const process = deps.processes.create({ processId: "jira_issue_process" });
						commandState.process = process;
						const action = createDueAction(deps, process);
						consumeScheduledAction = () => {
							deps.futureExecutions.delete(action.id);
						};
						return action;
					})();

		const result = await service.runDueWork(execution.nextRunAt);

		expect(result.items).toContainEqual({
			futureExecutionId: execution.id,
			kind: "durable_work_committed",
		});
		expect(deps.futureExecutions.getById(execution.id)).toBeNull();
		if (kind === "launch") {
			expect(deps.processes.listAll()).toHaveLength(1);
		} else {
			expect(executeProcessAction).toHaveBeenCalledOnce();
		}
	});

	it.each([
		{ resultKind: "success", expectedOutcome: "durable_work_committed" },
		{ resultKind: "pre_commit_failure", expectedOutcome: "occurrence_advanced" },
	] as const)("advances recurring actions after $resultKind", async ({
		resultKind,
		expectedOutcome,
	}) => {
		const commandState: { process?: ProcessInstance } = {};
		const executeProcessAction = vi.fn(async () =>
			resultKind === "success"
				? { ok: true as const, process: commandState.process ?? null, data: {} }
				: {
						ok: false as const,
						stage: "pre_commit" as const,
						process: commandState.process,
						error: "temporarily unavailable",
						code: "worker_unavailable",
					},
		);
		const { deps, service } = createServiceHarness({
			commands: { executeProcessAction } as unknown as ProcessEngine,
		});
		const process = deps.processes.create({ processId: "jira_issue_process" });
		commandState.process = process;
		const execution = createDueAction(deps, process, {
			scheduleKind: "cron",
			cronExpression: "0 9 * * *",
		});

		const result = await service.runDueWork(execution.nextRunAt);

		expect(result.items).toContainEqual({
			futureExecutionId: execution.id,
			kind: expectedOutcome,
		});
		expect(deps.futureExecutions.getById(execution.id)?.nextRunAt).toBe("2027-04-26T09:00:00.000Z");
	});

	it("advances a blocked recurring occurrence without executing it", async () => {
		const executeProcessAction = vi.fn();
		const { deps, service } = createServiceHarness({
			commands: { executeProcessAction } as unknown as ProcessEngine,
		});
		const process = deps.processes.create({ processId: "jira_issue_process" });
		const execution = createDueAction(deps, process, {
			scheduleKind: "cron",
			cronExpression: "0 9 * * *",
			blockedReason: {
				code: "model_unavailable",
				selection: null,
				summary: "Model unavailable",
				detectedAt: "2027-04-25T08:00:00.000Z",
			},
		});

		const result = await service.runDueWork(execution.nextRunAt);

		expect(result.items).toContainEqual({
			futureExecutionId: execution.id,
			kind: "occurrence_advanced",
		});
		expect(executeProcessAction).not.toHaveBeenCalled();
		expect(deps.futureExecutions.getById(execution.id)?.nextRunAt).toBe("2027-04-26T09:00:00.000Z");
	});

	it("advances missed startup cron occurrences without backfill and executes exact-time work", async () => {
		const { deps, service } = createServiceHarness();
		const missed = createDueLaunch(deps, {
			scheduleKind: "cron",
			cronExpression: "0 9 * * *",
			nextRunAt: "2027-04-24T09:00:00.000Z",
		});
		const exact = createDueLaunch(deps, {
			scheduleKind: "cron",
			cronExpression: "0 9 * * *",
			nextRunAt: "2027-04-25T09:00:00.000Z",
		});

		await service.reconcileMissedScheduleOccurrences("2027-04-25T09:00:00.000Z");
		expect(deps.processes.listAll()).toHaveLength(0);
		expect(deps.futureExecutions.getById(missed.id)?.nextRunAt).toBe("2027-04-26T09:00:00.000Z");
		expect(deps.futureExecutions.getById(exact.id)?.nextRunAt).toBe(exact.nextRunAt);

		const result = await service.runDueWork("2027-04-25T09:00:00.000Z");

		expect(result.items).toContainEqual({
			futureExecutionId: exact.id,
			kind: "durable_work_committed",
		});
		expect(deps.processes.listAll()).toHaveLength(1);
		expect(deps.futureExecutions.getById(exact.id)?.nextRunAt).toBe("2027-04-26T09:00:00.000Z");
	});

	it("re-reads a stale due row before attempting durable work", async () => {
		const { deps, service } = createServiceHarness();
		const execution = createDueLaunch(deps);
		const listRunnableDue = deps.futureExecutions.listRunnableDue.bind(deps.futureExecutions);
		vi.spyOn(deps.futureExecutions, "listRunnableDue").mockImplementation((asOf) => {
			const rows = listRunnableDue(asOf);
			deps.futureExecutions.update(execution.id, {
				nextRunAt: "2027-04-26T09:00:00.000Z",
			});
			return rows;
		});

		const result = await service.runDueWork(execution.nextRunAt);

		expect(result.items).toContainEqual({
			futureExecutionId: execution.id,
			kind: "no_work",
		});
		expect(deps.processes.listAll()).toHaveLength(0);
	});

	it("isolates unexpected due-row failures within a batch", async () => {
		let preparation = 0;
		const { deps, service } = createServiceHarness({
			launchPlans: {
				async prepare(launchPlan) {
					preparation += 1;
					if (preparation === 1) throw new Error("preparation infrastructure failed");
					return { ok: true as const, launchPlan };
				},
			},
		});
		const failing = createDueLaunch(deps);
		const succeeding = createDueLaunch(deps);

		const result = await service.runDueWork(failing.nextRunAt);

		expect(result.items).toContainEqual({
			futureExecutionId: failing.id,
			kind: "unexpected_error",
			error: "preparation infrastructure failed",
		});
		expect(result.items).toContainEqual({
			futureExecutionId: succeeding.id,
			kind: "durable_work_committed",
		});
		expect(deps.futureExecutions.getById(failing.id)).toMatchObject({ id: failing.id });
		expect(deps.futureExecutions.getById(succeeding.id)).toBeNull();
	});

	it("removes an invalid scheduled launch payload", async () => {
		const { deps, service } = createServiceHarness();
		const execution = createDueLaunch(deps, { payloadJson: "{" });

		const result = await service.runDueWork(execution.nextRunAt);

		expect(result.items).toContainEqual({
			futureExecutionId: execution.id,
			kind: "terminal_invalid_removed",
		});
		expect(deps.futureExecutions.getById(execution.id)).toBeNull();
	});

	it.each([
		"broadcast",
		"title",
		"extension",
	] as const)("reports committed due launch work when the %s reaction fails", async (failure) => {
		const { deps, service } = createServiceHarness({
			failProcessTitleQueue: failure === "title",
			...(failure === "extension"
				? {
						extensionHost: {
							on() {},
							off() {},
							async emit() {
								throw new Error("extension unavailable");
							},
						},
					}
				: {}),
		});
		if (failure === "broadcast") {
			deps.broadcaster.broadcast = () => {
				throw new Error("broadcast unavailable");
			};
		}
		const execution = createDueLaunch(deps);

		const result = await service.runDueWork(execution.nextRunAt);

		expect(result.items).toContainEqual(
			expect.objectContaining({
				futureExecutionId: execution.id,
				kind: "durable_work_committed_with_reaction_error",
			}),
		);
		expect(deps.processes.listAll()).toHaveLength(1);
		expect(deps.futureExecutions.getById(execution.id)).toBeNull();
	});

	it.each([
		"launch",
		"action",
	] as const)("propagates the persisted actor for due %s work", async (kind) => {
		const startProcess = vi.fn(async (instanceId: string) => ({
			ok: true as const,
			process: { id: instanceId } as ProcessInstance,
			data: undefined,
		}));
		const executeProcessAction = vi.fn();
		const commandState: { process?: ProcessInstance } = {};
		executeProcessAction.mockImplementation(async () => ({
			ok: true,
			process: commandState.process,
			data: {},
		}));
		const { deps, service } = createServiceHarness({
			startTurnId: kind === "launch" ? "run" : null,
			commands: {
				startProcess,
				executeProcessAction,
			} as unknown as ProcessEngine,
		});
		if (kind === "launch") {
			const launchPlan = createTestLaunchPlan({
				launcherId: "demo.launcher",
				processId: "jira_issue_process",
				startTurnId: "run",
				processInput: {
					processId: "jira_issue_process",
					selectedTurnId: null,
					paramsJson: "{}",
					stateJson: "{}",
				},
			});
			createDueLaunch(deps, {
				payloadJson: serializeFutureLaunchPayload({
					launcherInput: {},
					modelConfig: {},
					actor: ADMIN_ACTOR,
					launchPlan,
				}),
			});
		} else {
			const process = deps.processes.create({ processId: "jira_issue_process" });
			commandState.process = process;
			createDueAction(deps, process, {
				payloadJson: serializeFutureActionPayload({
					input: { approved: true },
					nextTurnModelProfileId: null,
					actionLabel: "Approve plan",
					actor: ADMIN_ACTOR,
				}),
			});
		}

		await service.runDueWork("2027-04-25T09:00:00.000Z");

		const command = kind === "launch" ? startProcess : executeProcessAction;
		expect(command).toHaveBeenCalledWith(
			expect.any(String),
			...(kind === "launch" ? ["run"] : ["approve_plan", { approved: true }]),
			expect.objectContaining({ actor: ADMIN_ACTOR }),
		);
	});
});
