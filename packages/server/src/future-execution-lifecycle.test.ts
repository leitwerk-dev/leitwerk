import { ADMIN_ACTOR, type ProcessInstance, SYSTEM_ACTOR } from "@leitwerk-dev/domain";
import { type LaunchPreparationCheck, SafeLaunchPreparationError } from "@leitwerk-dev/process-sdk";
import {
	parseFutureActionPayloadJson,
	parseFutureLaunchPayloadJson,
	parseLauncherRequestBody,
	serializeFutureActionPayload,
	serializeFutureLaunchPayload,
} from "@leitwerk-dev/protocol";
import { describe, expect, it, vi } from "vitest";
import { getDefaultConfig } from "./config/config-loader.js";
import { createExtensionHost } from "./extensions/extension-host.js";
import { createFutureExecutionLifecycle } from "./future-execution/index.js";
import { createLaunchPipeline } from "./launch-pipeline.js";
import type { ProcessActionRegistry } from "./process-action-registry.js";
import { createProcessEngine } from "./process-engine/engine.js";
import type { ProcessEngine } from "./process-engine/types.js";
import { createServerProcessModelPolicy } from "./process-model-policy/index.js";
import { createProcessOperationCoordinator } from "./process-operation-coordinator.js";
import { createOwnedTestDeps } from "./test-helpers/owned-test-deps.js";
import { createDefaultTestProcessGraphRegistry } from "./test-helpers/process-fixtures.js";
import { createTestLaunchPlan } from "./test-helpers/process-model-fixtures.js";
import { installTestSkill } from "./test-helpers/skill-fixtures.js";

function createServiceHarness(
	options: {
		commands?: ProcessEngine;
		extensionHost?: Parameters<typeof createFutureExecutionLifecycle>[0]["extensionHost"];
		launcherRecentValues?: Parameters<
			typeof createFutureExecutionLifecycle
		>[0]["launcherRecentValues"];
		launchPlans?: Parameters<typeof createFutureExecutionLifecycle>[0]["launchPlans"];
		preparationChecks?: readonly LaunchPreparationCheck[];
		processActionRegistry?: ProcessActionRegistry;
		startTurnId?: string | null;
		failTitleQueue?: boolean;
		failProcessTitleQueue?: boolean;
		skillDefaults?: Parameters<typeof createFutureExecutionLifecycle>[0]["skillDefaults"];
	} = {},
) {
	const deps = createOwnedTestDeps();
	const processOperations = createProcessOperationCoordinator();
	const processGraphs = createDefaultTestProcessGraphRegistry();
	const processModelPolicy = createServerProcessModelPolicy({
		config: getDefaultConfig(),
		processGraphs,
		processActionRegistry: {
			getTurnDefinition: () => undefined,
			resolveContextData: () => ({ params: {}, state: {} }),
		},
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
		resolvePreparationChecks() {
			return options.preparationChecks ?? [];
		},
		async resolveUiLauncher() {
			return {
				ok: true as const,
				launcher: {
					processId: "ticket_issue_process",
					launcherId: "demo.launcher",
					launchPlan: createTestLaunchPlan({
						launcherId: "demo.launcher",
						processId: "ticket_issue_process",
						startTurnId: options.startTurnId ?? null,
						processInput: {
							processId: "ticket_issue_process",
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
	const launchPipeline = createLaunchPipeline({
		launchRuns: deps.launchRuns,
		broadcaster: deps.broadcaster,
	});
	const service = createFutureExecutionLifecycle({
		...deps,
		skillDefaults: options.skillDefaults,
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
		launchPipeline,
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

describe("default skills for launches and schedules", () => {
	function request(body: Record<string, unknown> = {}) {
		const parsed = parseLauncherRequestBody({
			launcherInput: {},
			skillIds: [],
			schedule: { mode: "once", runAt: "2099-04-25T09:00:00.000Z" },
			...body,
		});
		if (!parsed.ok) throw new Error(parsed.error);
		return parsed.value;
	}

	it.each(["now", "once", "cron"])("pins defaults on new %s launches", async (mode) => {
		const skillDefaults = { default_skills: ["shared"] };
		const { deps, service } = createServiceHarness({ skillDefaults });
		const pinned = installTestSkill(deps, "shared");
		const prepared = await service.prepareLaunch(
			"demo.launcher",
			request({
				schedule: { mode, runAt: "2099-04-25T09:00:00.000Z", cronExpression: "0 9 * * *" },
			}),
		);
		if (!prepared.ok) throw new Error(JSON.stringify(prepared));
		expect(prepared.prepared.selectedSkillIds).toEqual([]);
		expect(prepared.prepared.resourceSelections).toEqual(pinned);
		const result = await service.commitPreparedLaunch(prepared.prepared);
		if (result.kind === "launched") {
			expect(deps.processSkills.listSelections(result.process.id)).toEqual(pinned);
		} else if (result.kind === "scheduled") {
			expect(parseFutureLaunchPayloadJson(result.execution.payloadJson)).toMatchObject({
				ok: true,
				value: { selectedSkillIds: [], resourceSelections: pinned },
			});
		} else throw new Error(JSON.stringify(result));
	});

	it("fails unavailable defaults without creating a process or schedule", async () => {
		const { deps, service } = createServiceHarness({
			skillDefaults: { default_skills: ["missing"] },
		});
		expect(await service.prepareLaunch("demo.launcher", request())).toMatchObject({
			ok: false,
			outcome: { kind: "invalid", issues: [{ code: "invalid_skill_selection" }] },
		});
		expect(deps.futureExecutions.listAll()).toEqual([]);
		expect(deps.processes.listAll()).toEqual([]);
	});

	it("preserves schedule pins during validation and edits until the selection changes", async () => {
		const skillDefaults = { default_skills: ["shared"] };
		const { deps, service } = createServiceHarness({ skillDefaults });
		const pinned = installTestSkill(deps, "shared");
		const explicit = installTestSkill(deps, "extra");
		const result = await launch(service, "demo.launcher", request({ skillIds: ["extra"] }));
		if (result.kind !== "scheduled") throw new Error(JSON.stringify(result));
		const newer = installTestSkill(deps, "shared", "Updated instructions.");
		expect(newer).not.toEqual(pinned);
		deps.skills.remove("shared");
		deps.skills.remove("extra");
		skillDefaults.default_skills = ["missing"];
		const unchanged = request({ skillIds: ["extra"], title: "New title" });
		const preview = await service.prepareLaunch("demo.launcher", unchanged, {
			futureExecutionId: result.execution.id,
		});
		expect(preview).toMatchObject({
			ok: true,
			prepared: { resourceSelections: [...pinned, ...explicit] },
		});
		const updated = await service.reviseScheduledLaunch(result.execution.id, unchanged);
		if (updated.kind !== "scheduled") throw new Error(JSON.stringify(updated));
		expect(parseFutureLaunchPayloadJson(updated.execution.payloadJson)).toMatchObject({
			ok: true,
			value: { selectedSkillIds: ["extra"], resourceSelections: [...pinned, ...explicit] },
		});
		const changed = request({ skillIds: [] });
		expect(await service.reviseScheduledLaunch(result.execution.id, changed)).toMatchObject({
			kind: "invalid",
			issues: [{ code: "invalid_skill_selection" }],
		});
		expect(deps.futureExecutions.getById(result.execution.id)?.payloadJson).toBe(
			updated.execution.payloadJson,
		);
		skillDefaults.default_skills = ["shared"];
		installTestSkill(deps, "shared", "Updated instructions.");
		const changedPreview = await service.prepareLaunch("demo.launcher", changed, {
			futureExecutionId: result.execution.id,
		});
		expect(changedPreview).toMatchObject({ ok: true, prepared: { resourceSelections: newer } });
		const revised = await service.reviseScheduledLaunch(result.execution.id, changed);
		if (revised.kind !== "scheduled") throw new Error(JSON.stringify(revised));
		expect(parseFutureLaunchPayloadJson(revised.execution.payloadJson)).toMatchObject({
			ok: true,
			value: { selectedSkillIds: [], resourceSelections: newer },
		});
	});

	it("keeps scheduled revisions on repeated occurrences after removal and default changes", async () => {
		const skillDefaults = { default_skills: ["shared"] };
		const { deps, service } = createServiceHarness({ skillDefaults });
		const pinned = installTestSkill(deps, "shared");
		const result = await launch(
			service,
			"demo.launcher",
			request({ schedule: { mode: "cron", cronExpression: "0 9 * * *" } }),
		);
		if (result.kind !== "scheduled") throw new Error(JSON.stringify(result));
		skillDefaults.default_skills = ["missing"];
		deps.skills.remove("shared");
		for (let occurrence = 0; occurrence < 2; occurrence += 1) {
			const current = deps.futureExecutions.getById(result.execution.id);
			if (!current) throw new Error("Missing recurring schedule");
			await service.runDueWork(current.nextRunAt);
		}
		expect(deps.processes.listAll()).toHaveLength(2);
		for (const process of deps.processes.listAll()) {
			expect(deps.processSkills.listSelections(process.id)).toEqual(pinned);
			expect(deps.processSkills.listResourceLayers(process.id)).toHaveLength(1);
		}
	});

	it("launches legacy empty schedules without resolving current defaults", async () => {
		const { deps, service } = createServiceHarness({
			skillDefaults: { default_skills: ["missing"] },
		});
		const existing = createDueLaunch(deps);
		const result = await service.reviseScheduledLaunch(
			existing.id,
			request({ schedule: { mode: "now" } }),
		);
		if (result.kind !== "launched") throw new Error(JSON.stringify(result));
		expect(deps.processSkills.listSelections(result.process.id)).toEqual([]);
	});

	it("rejects validation context for missing schedules and other launchers", async () => {
		const { deps, service } = createServiceHarness();
		const existing = createDueLaunch(deps, { launcherId: "other.launcher" });
		expect(
			await service.prepareLaunch("demo.launcher", request(), { futureExecutionId: existing.id }),
		).toMatchObject({ ok: false, outcome: { kind: "invalid" } });
		expect(
			await service.prepareLaunch("demo.launcher", request(), { futureExecutionId: "missing" }),
		).toMatchObject({ ok: false, outcome: { kind: "not_found" } });
	});
});

async function launch(
	service: ReturnType<typeof createFutureExecutionLifecycle>,
	launcherId: string,
	request: Parameters<ReturnType<typeof createFutureExecutionLifecycle>["prepareLaunch"]>[1],
	options?: { actor?: typeof ADMIN_ACTOR },
) {
	const prepared = await service.prepareLaunch(launcherId, request);
	return prepared.ok ? service.commitPreparedLaunch(prepared.prepared, options) : prepared.outcome;
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
	deps: ReturnType<typeof createOwnedTestDeps>,
	overrides: Partial<Parameters<typeof deps.futureExecutions.create>[0]> = {},
) {
	const launchPlan = createTestLaunchPlan({
		launcherId: "demo.launcher",
		processId: "ticket_issue_process",
		startTurnId: null,
		processInput: {
			processId: "ticket_issue_process",
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
	deps: ReturnType<typeof createOwnedTestDeps>,
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
		const emittedEvents: unknown[] = [];
		const { service } = createServiceHarness({
			extensionHost: {
				on() {},
				off() {},
				emit: async (event, payload) => {
					emittedEvents.push({ event, payload });
				},
			},
		});

		const result = await launch(service, "demo.launcher", {
			title: null,
			titleProvided: false,
			launcherInput: {},
			launcherInputProvided: true,
			modelConfig: {},
			modelConfigProvided: false,
			schedule: { mode: "now" },
			scheduleProvided: true,
		});

		if (result.kind !== "launched") throw new Error("Expected launched process");
		expect(emittedEvents).toMatchObject([
			{ event: "process_created", payload: { instanceId: result.process.id } },
		]);
	});

	it("records launcher recent values after successful launch-now requests", async () => {
		const recorded: Array<{ launcherId: string; launcherInput: Record<string, unknown> }> = [];
		const { service } = createServiceHarness({
			launcherRecentValues: {
				list: () => ({}),
				record: (launcherId, launcherInput) => recorded.push({ launcherId, launcherInput }),
			},
		});

		const result = await launch(service, "demo.launcher", {
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

		const result = await launch(
			service,
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

		const result = await launch(service, "demo.launcher", {
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
			processId: "ticket_issue_process",
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
		const process = deps.processes.create({ processId: "ticket_issue_process" });
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
		const process = deps.processes.create({ processId: "ticket_issue_process" });
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
		const process = deps.processes.create({ processId: "ticket_issue_process" });
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
		const process = deps.processes.create({ processId: "ticket_issue_process" });
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
		const process = deps.processes.create({ processId: "ticket_issue_process" });
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
		const process = deps.processes.create({ processId: "ticket_issue_process" });
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
			processId: "ticket_issue_process",
			startTurnId: "run",
			processInput: {
				processId: "ticket_issue_process",
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
		if (!("process" in outcome)) throw new Error("Expected committed process");
		expect(deps.launchRuns.listByInstance(outcome.process.id)).toMatchObject([
			{
				origin: "ui",
				status: "failed",
				steps: expect.arrayContaining([
					expect.objectContaining({ id: "create_process", status: "completed" }),
					expect.objectContaining({ id: "start_worker", status: "failed" }),
				]),
			},
		]);
	});

	it("admits update-to-now preparation failures without consuming the future launch", async () => {
		let shouldFail = true;
		let observedRunId = "";
		const { deps, service } = createServiceHarness({
			preparationChecks: [
				{
					id: "repository_access",
					label: "Check repository access",
					async run() {
						const run = deps.launchRuns.listIncomplete()[0];
						if (!run) throw new Error("Expected admitted launch before preparation");
						observedRunId = run.id;
						if (shouldFail)
							throw new SafeLaunchPreparationError(
								"Repository access failed",
								"Repository is unavailable",
							);
					},
				},
			],
		});
		const execution = createDueLaunch(deps);
		const request = {
			title: null,
			titleProvided: false,
			launcherInput: {},
			launcherInputProvided: false,
			modelConfig: {},
			modelConfigProvided: false,
			schedule: { mode: "now" as const },
			scheduleProvided: true,
		};

		const rejected = await service.reviseScheduledLaunch(execution.id, request);

		expect(rejected).toMatchObject({
			kind: "invalid",
			issues: [{ code: "preparation_failed" }],
		});
		const failedRunId = observedRunId;
		expect(deps.launchRuns.getById(failedRunId)).toMatchObject({
			origin: "ui",
			status: "failed",
			instanceId: null,
			steps: expect.arrayContaining([
				expect.objectContaining({
					id: "check:repository_access",
					status: "failed",
					safeSummary: "Repository is unavailable",
				}),
			]),
		});
		expect(deps.processes.listAll()).toHaveLength(0);
		expect(deps.futureExecutions.getById(execution.id)).toEqual(execution);

		shouldFail = false;
		const retried = await service.reviseScheduledLaunch(execution.id, request);

		expect(retried.kind).toBe("launched");
		expect(observedRunId).not.toBe(failedRunId);
		expect(deps.launchRuns.getById(observedRunId)).toMatchObject({
			status: "completed",
			steps: expect.arrayContaining([
				expect.objectContaining({ id: "check:repository_access", status: "completed" }),
			]),
		});
		expect(deps.processes.listAll()).toHaveLength(1);
		expect(deps.futureExecutions.getById(execution.id)).toBeNull();
	});

	it.each([
		"once",
		"cron",
	] as const)("atomically correlates update-to-now and consumes the %s schedule once", async (scheduleKind) => {
		const committedSnapshots: Array<{
			processId: string;
			runCount: number;
			scheduleExists: boolean;
		}> = [];
		const extensionHost = createExtensionHost();
		const { deps, service } = createServiceHarness({ extensionHost });
		const execution = createDueLaunch(deps, {
			scheduleKind,
			...(scheduleKind === "cron" ? { cronExpression: "0 9 * * *" } : {}),
		});
		extensionHost.on("process_created", ({ process }) => {
			committedSnapshots.push({
				processId: process.id,
				runCount: deps.launchRuns.listByInstance(process.id).length,
				scheduleExists: deps.futureExecutions.getById(execution.id) !== null,
			});
		});
		const request = {
			title: "Launch now",
			titleProvided: true,
			launcherInput: {},
			launcherInputProvided: false,
			modelConfig: {},
			modelConfigProvided: false,
			schedule: { mode: "now" as const },
			scheduleProvided: true,
		};

		const [launched, repeated, due] = await Promise.all([
			service.reviseScheduledLaunch(execution.id, request, { actor: ADMIN_ACTOR }),
			service.reviseScheduledLaunch(execution.id, request),
			service.runDueWork(execution.nextRunAt),
		]);

		expect(launched.kind).toBe("launched");
		if (launched.kind !== "launched") throw new Error("Expected committed process");
		expect(launched.process).toMatchObject({ title: "Launch now" });
		expect(repeated).toEqual({ kind: "not_found", target: "launch" });
		expect(due.items).toEqual([{ futureExecutionId: execution.id, kind: "no_work" }]);
		expect(deps.processes.listAll()).toHaveLength(1);
		expect(deps.futureExecutions.getById(execution.id)).toBeNull();
		expect(committedSnapshots).toEqual([
			{ processId: launched.process.id, runCount: 1, scheduleExists: false },
		]);
		expect(deps.launchRuns.listByInstance(launched.process.id)).toMatchObject([
			{ origin: "ui", status: "completed" },
		]);
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
						const process = deps.processes.create({ processId: "ticket_issue_process" });
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
			expect(
				deps.launchRuns.getByIdempotencyKey(`scheduled:${execution.id}:${execution.nextRunAt}`),
			).toMatchObject({
				origin: "scheduled",
				instanceId: deps.processes.listAll()[0]?.id,
				status: "completed",
			});
		} else {
			expect(executeProcessAction).toHaveBeenCalledOnce();
			expect(executeProcessAction).toHaveBeenCalledWith(
				commandState.process?.id,
				"approve_plan",
				{ approved: true },
				expect.objectContaining({
					source: "scheduled",
					scheduledExecutionId: execution.id,
					consumeScheduledExecutionOnSuccess: true,
				}),
			);
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
		const process = deps.processes.create({ processId: "ticket_issue_process" });
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
		const process = deps.processes.create({ processId: "ticket_issue_process" });
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
		expect(deps.futureExecutions.getById(execution.id)?.nextRunAt).toBe("2027-04-26T09:00:00.000Z");
	});

	it("retries a scheduled preparation rejection without creating a process", async () => {
		const { deps, service } = createServiceHarness({
			launchPlans: {
				async prepare(launchPlan) {
					return {
						ok: false as const,
						launchPlan,
						modelConfig: {},
						errors: [{ code: "invalid_model_config" as const, message: "Model unavailable" }],
					};
				},
			},
		});
		const execution = createDueLaunch(deps);

		const result = await service.runDueWork(execution.nextRunAt);

		expect(result.items).toContainEqual({
			futureExecutionId: execution.id,
			kind: "retry_scheduled",
		});
		expect(deps.processes.listAll()).toHaveLength(0);
		expect(deps.futureExecutions.getById(execution.id)?.nextRunAt).toBe("2027-04-25T09:01:00.000Z");
		expect(
			deps.launchRuns.getByIdempotencyKey(`scheduled:${execution.id}:${execution.nextRunAt}`),
		).toMatchObject({
			instanceId: null,
			status: "failed",
		});
	});

	it("maps unexpected preparation failures to retry and continues the batch", async () => {
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
		const succeeding = createDueLaunch(deps, { nextRunAt: "2027-04-25T09:00:01.000Z" });

		const result = await service.runDueWork(succeeding.nextRunAt);

		expect(result.items).toContainEqual({
			futureExecutionId: failing.id,
			kind: "retry_scheduled",
		});
		expect(result.items).toContainEqual({
			futureExecutionId: succeeding.id,
			kind: "durable_work_committed",
		});
		expect(deps.futureExecutions.getById(failing.id)?.nextRunAt).toBe("2027-04-25T09:01:01.000Z");
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
				processId: "ticket_issue_process",
				startTurnId: "run",
				processInput: {
					processId: "ticket_issue_process",
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
			const process = deps.processes.create({ processId: "ticket_issue_process" });
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
			kind === "launch" ? deps.processes.listAll()[0]?.id : commandState.process?.id,
			...(kind === "launch" ? ["run"] : ["approve_plan", { approved: true }]),
			expect.objectContaining({ actor: ADMIN_ACTOR }),
		);
	});
});
