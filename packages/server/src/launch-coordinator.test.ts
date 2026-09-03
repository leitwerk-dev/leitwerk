import { type LaunchRun, SYSTEM_ACTOR } from "@leitwerk-dev/domain";
import { type ProcessLaunchPlan, SafeLaunchPreparationError } from "@leitwerk-dev/process-sdk";
import { describe, expect, it, vi } from "vitest";
import {
	createCoordinatorHarness,
	createWatcherHarness,
	expectLaunchStep,
	startupSteps,
} from "./launch-coordinator-test-harness.js";
import { initialLaunchSteps } from "./launch-pipeline.js";

describe("LaunchCoordinator prepared-plan admission", () => {
	it("creates one durable run for idempotent prepared-plan launches", async () => {
		const harness = createCoordinatorHarness();
		const launchPlan: ProcessLaunchPlan = {
			launcherId: "ticket:tracker_create",
			processId: "ticket_process",
			processInput: {
				processId: "ticket_process",
				selectedTurnId: null,
				lifecycleStatus: "discovered",
				paramsJson: "{}",
				stateJson: "{}",
			},
			projectInputs: [],
			startTurnId: "draft",
		};
		const createProcessFromLaunchPlan = vi.fn(async () => ({
			ok: true as const,
			process: harness.repos.processes.create({ processId: "ticket_process" }),
			projects: [],
			reused: false,
		}));
		Object.assign(harness.processLaunches, { createProcessFromLaunchPlan });
		const request = {
			launchPlan,
			idempotencyKey: "ticket:request-1",
			actor: SYSTEM_ACTOR,
			origin: "ui" as const,
			relation: {
				parentInstanceId: "parent-1",
				purpose: "ticket_creation",
				createdBy: SYSTEM_ACTOR,
			},
		};

		const first = await harness.coordinator.startPreparedPlan(request);
		const second = await harness.coordinator.startPreparedPlan(request);

		expect(second).toEqual(first);
		expect(createProcessFromLaunchPlan).toHaveBeenCalledTimes(1);
		expect(createProcessFromLaunchPlan).toHaveBeenCalledWith(
			launchPlan,
			expect.objectContaining({ launchRunId: first.launchRunId, relation: request.relation }),
		);
		expect(harness.repos.launchRuns.getById(first.launchRunId)).toMatchObject({
			instanceId: first.process?.id,
			status: "starting",
		});
	});
});

describe("LaunchCoordinator UI adapter failures", () => {
	it("stops after a safe preparation-check failure", async () => {
		const harness = createCoordinatorHarness({
			checks: [
				{
					id: "repository_access",
					label: "Check repository access",
					async run() {
						throw new SafeLaunchPreparationError(
							"access denied",
							"Authorize repository access, then retry.",
						);
					},
				},
			],
		});

		const result = await harness.runProgrammatic();

		expect(result).toMatchObject({ process: null, error: "Launch preparation failed" });
		expect(harness.prepareLaunch).not.toHaveBeenCalled();
		expect(harness.run()).toMatchObject({ status: "failed" });
		expectLaunchStep(
			harness.run(),
			"check:repository_access",
			"failed",
			"Authorize repository access, then retry.",
		);
	});

	it.each([
		{
			name: "launcher resolution",
			overrides: {
				resolve: async () => ({
					ok: false,
					errors: [{ code: "invalid_input", message: "Repository is required" }],
				}),
			},
			error: "Repository is required",
			step: "validate_request",
		},
		{
			name: "launch preparation",
			overrides: {
				prepare: async () => ({
					ok: false,
					outcome: {
						kind: "invalid",
						issues: [{ code: "invalid_model_config", message: "Model unavailable" }],
					},
				}),
			},
			error: "Model unavailable",
			step: "resolve_models_skills",
		},
		{
			name: "pre-commit creation",
			overrides: {
				commit: async () => ({
					kind: "failed",
					issue: { code: "process_launch_failed", message: "Database unavailable" },
				}),
			},
			error: "Database unavailable",
			step: "create_process",
		},
	])("records $name failures at the active step", async ({ overrides, error, step }) => {
		const harness = createCoordinatorHarness(overrides);
		expect(await harness.runProgrammatic()).toMatchObject({ process: null, error });
		expect(harness.repos.processes.listAll()).toHaveLength(0);
		expect(harness.run()).toMatchObject({ instanceId: null, status: "failed" });
		expectLaunchStep(harness.run(), step, "failed");
	});
});

describe("LaunchCoordinator programmatic admission", () => {
	it("creates one durable run and merges trusted process metadata", async () => {
		const harness = createCoordinatorHarness();
		const request = {
			launcherId: "demo.ui",
			launcherInput: { prompt: "hello" },
			processMetadata: { delivery: { channelId: "channel-1", threadId: 7 } },
		};
		const opts = { idempotencyKey: "programmatic:channel-1:7:submission", actor: SYSTEM_ACTOR };

		const first = await harness.coordinator.startProgrammatic(request, opts);
		const second = await harness.coordinator.startProgrammatic(request, opts);

		expect(first.process).not.toBeNull();
		expect(second).toMatchObject({ launchRunId: first.launchRunId, process: first.process });
		expect(harness.repos.launchRuns.getById(first.launchRunId)).toMatchObject({
			origin: "programmatic",
			instanceId: first.process?.id,
		});
		expect(harness.prepareLaunch).toHaveBeenCalledOnce();
		expect(harness.commitPreparedLaunch).toHaveBeenCalledWith(
			expect.objectContaining({
				launchPlan: expect.objectContaining({
					processInput: expect.objectContaining({
						metadata: {
							existing: true,
							delivery: { channelId: "channel-1", threadId: 7 },
						},
					}),
				}),
			}),
			expect.objectContaining({ launchRunId: first.launchRunId }),
		);
	});
});

describe("LaunchCoordinator reconciliation", () => {
	it("resumes a pre-commit UI launch from its server-private replay", async () => {
		let harness!: ReturnType<typeof createCoordinatorHarness>;
		harness = createCoordinatorHarness({
			commit: async () => ({
				kind: "launched",
				process: harness.repos.processes.create({
					processId: "demo",
					selectedTurnId: null,
					lifecycleStatus: "completed",
				}),
				projects: [],
				operation: "created",
			}),
		});
		const run = harness.repos.launchRuns.create({
			launcherId: "demo.ui",
			origin: "ui",
			steps: initialLaunchSteps().map((step) =>
				step.id === "validate_request" ? { ...step, status: "in_progress" } : step,
			),
		});
		harness.repos.launchRuns.saveReplay(run.id, harness.request);

		await harness.coordinator.reconcileIncomplete();

		expect(harness.commitPreparedLaunch).toHaveBeenCalledOnce();
		expect(harness.repos.launchRuns.getById(run.id)).toMatchObject({
			instanceId: expect.stringMatching(/^agt_/),
			status: "completed",
		});
		expect(harness.repos.launchRuns.getReplay(run.id)).toBeNull();
	});

	it("does not replay process creation after a correlated commit", async () => {
		const harness = createCoordinatorHarness();
		const process = harness.repos.processes.create({ processId: "demo" });
		const run = harness.repos.launchRuns.create({
			launcherId: "demo.ui",
			idempotencyKey: "ui:committed-before-restart",
			origin: "ui",
			steps: initialLaunchSteps(),
		});
		harness.repos.launchRuns.update(run.id, (run) => ({
			...run,
			instanceId: process.id,
			status: "process_created",
		}));
		harness.repos.launchRuns.saveReplay(run.id, harness.request);

		await harness.coordinator.reconcileIncomplete();

		expect(harness.commitPreparedLaunch).not.toHaveBeenCalled();
		expect(harness.repos.processes.listAll()).toEqual([
			expect.objectContaining({ id: process.id }),
		]);
		expect(harness.repos.launchRuns.getById(run.id)).toMatchObject({
			instanceId: process.id,
		});
	});

	it("retains safe watcher remediation without committing a process", async () => {
		const createProcess = vi.fn();
		const { coordinator } = createWatcherHarness({
			launchPlans: { prepare: vi.fn() },
			processLaunches: {
				createProcessFromLaunchPlan: createProcess,
			},
		});
		const result = await coordinator.startWatcher(
			{
				processId: "demo",
				watcherId: "issues",
				launchModelConfig: {},
				resolveLaunchAttempt: async () => ({
					launchConfig: { params: {} },
					launchPlan: { processId: "demo", processInput: {} },
					preparationChecks: [
						{
							id: "access",
							label: "Check access",
							async run() {
								throw new SafeLaunchPreparationError(
									"access failed",
									"Authorize repository access, then retry.",
								);
							},
						},
					],
				}),
			} as never,
			{},
			{ idempotencyKey: "watcher:demo:1", actor: SYSTEM_ACTOR },
		);

		expect(result).toMatchObject({
			process: null,
			error: "Authorize repository access, then retry.",
		});
		expect(createProcess).not.toHaveBeenCalled();
	});

	it("keeps the stable watcher key and cancels deduplicated startup progress", async () => {
		const { coordinator, process, repos, launchPlans, processLaunches } = createWatcherHarness();
		const failed = repos.launchRuns.create({
			launcherId: "demo.issues",
			idempotencyKey: "watcher:demo:retry",
			origin: "watcher",
			steps: startupSteps,
		});
		repos.launchRuns.update(failed.id, (run) => ({
			...run,
			status: "failed",
			completedAt: new Date().toISOString(),
		}));
		vi.spyOn(repos.turnRecords, "listByInstance").mockReturnValue([{} as never]);
		const createProcess = vi.fn(async () => ({
			ok: true as const,
			process,
			projects: [],
			reused: true,
		}));
		const watcher = {
			processId: "demo",
			watcherId: "issues",
			launchModelConfig: {},
			resolveLaunchAttempt: async () => ({
				launchConfig: { params: {} },
				launchPlan: { processId: "demo", processInput: {}, startTurnId: "start" },
				preparationChecks: [],
			}),
		} as never;
		const services = {
			launchPlans: {
				prepare: vi.fn(async (launchPlan) => ({ ok: true, launchPlan })),
			},
			processLaunches: {
				createProcessFromLaunchPlan: createProcess,
			},
		};
		const request = { idempotencyKey: "watcher:demo:retry", actor: SYSTEM_ACTOR };

		Object.assign(launchPlans, services.launchPlans);
		Object.assign(processLaunches, services.processLaunches);
		const retried = await coordinator.startWatcher(watcher, {}, request);
		const replayed = await coordinator.startWatcher(watcher, {}, request);

		expect(replayed.launchRunId).toBe(retried.launchRunId);
		expect(createProcess).toHaveBeenCalledOnce();
		expect(repos.launchRuns.getByIdempotencyKey(request.idempotencyKey)).toMatchObject({
			id: retried.launchRunId,
			instanceId: process.id,
			status: "cancelled",
		});
		expect(repos.launchRuns.getById(failed.id)).toMatchObject({ status: "failed" });
		expect(
			repos.launchRuns
				.getById(retried.launchRunId)
				?.steps.filter((item) => item.id.startsWith("start_") || item.id === "connect_worker"),
		).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "start_worker", status: "pending" }),
				expect.objectContaining({ id: "connect_worker", status: "pending" }),
				expect.objectContaining({ id: "start_first_turn", status: "pending" }),
			]),
		);
	});

	it("fails a deduplicated watcher run when the existing process has no worker", async () => {
		const { coordinator, process, repos, launchPlans, processLaunches } = createWatcherHarness();
		const lease = repos.leases.getByInstance(process.id);
		if (!lease) throw new Error("Expected worker lease");
		repos.leases.update(lease.id, { state: "exited", exitedAt: new Date().toISOString() });
		const failed = repos.launchRuns.create({
			launcherId: "demo.issues",
			idempotencyKey: "watcher:demo:stuck",
			origin: "watcher",
			steps: startupSteps,
		});
		repos.launchRuns.update(failed.id, (run) => ({
			...run,
			status: "failed",
			completedAt: new Date().toISOString(),
		}));
		Object.assign(launchPlans, {
			prepare: async (launchPlan: unknown) => ({ ok: true, launchPlan }),
		});
		Object.assign(processLaunches, {
			createProcessFromLaunchPlan: async () => ({
				ok: true,
				process,
				projects: [],
				reused: true,
			}),
		});

		const result = await coordinator.startWatcher(
			{
				processId: "demo",
				watcherId: "issues",
				launchModelConfig: {},
				resolveLaunchAttempt: async () => ({
					launchConfig: { params: {} },
					launchPlan: { processId: "demo", processInput: {}, startTurnId: "start" },
					preparationChecks: [],
				}),
			} as never,
			{},
			{ idempotencyKey: "watcher:demo:stuck", actor: SYSTEM_ACTOR },
		);

		expect(result.process).toMatchObject({ id: process.id });
		expect(repos.launchRuns.getById(result.launchRunId)).toMatchObject({ status: "failed" });
		expectLaunchStep(
			repos.launchRuns.getById(result.launchRunId),
			"start_worker",
			"failed",
			expect.stringContaining("has not started a worker"),
		);
	});

	it("repairs a launch run when read and broadcasts only a changed projection", () => {
		const { broadcaster, coordinator, run } = createWatcherHarness();
		const before = broadcaster.sendDurable.mock.calls.length;

		const repaired = coordinator.get(run().id);

		expectLaunchStep(repaired, "start_worker", "pending");
		expect(broadcaster.sendDurable).toHaveBeenCalledTimes(before + 1);
		coordinator.get(run().id);
		expect(broadcaster.sendDurable).toHaveBeenCalledTimes(before + 1);
	});

	it("cancels stale duplicate watcher launch runs during reconciliation", async () => {
		const { coordinator, process, repos, run } = createWatcherHarness();
		const duplicates = Array.from({ length: 172 }, () => {
			const created = repos.launchRuns.create({
				launcherId: "demo.issues",
				origin: "watcher",
				steps: startupSteps.map((step) =>
					step.id === "choose_title" ? step : { ...step, status: "pending" as const },
				),
			});
			return repos.launchRuns.update(created.id, (current) => ({
				...current,
				instanceId: process.id,
				status: "starting",
			})) as LaunchRun;
		});

		await coordinator.reconcileIncomplete();

		expect(run().status).toBe("cancelled");
		expect(
			duplicates.filter(
				(duplicate) => repos.launchRuns.getById(duplicate.id)?.status === "cancelled",
			),
		).toHaveLength(171);
		expect(
			duplicates.filter(
				(duplicate) => repos.launchRuns.getById(duplicate.id)?.status !== "cancelled",
			),
		).toHaveLength(1);
	});

	it("breaks equal creation timestamps by the latest durable run id", async () => {
		const { coordinator, process, repos, run } = createWatcherHarness();
		repos.launchRuns.update(run().id, (current) => ({
			...current,
			status: "cancelled",
			completedAt: current.updatedAt,
		}));
		const createdAt = "2026-01-01T00:00:00.000Z";
		const duplicates = Array.from({ length: 2 }, () => {
			const created = repos.launchRuns.create({
				launcherId: "demo.ui",
				origin: "ui",
				steps: initialLaunchSteps(),
			});
			return repos.launchRuns.update(created.id, (current) => ({
				...current,
				instanceId: process.id,
				status: "starting",
				createdAt,
			})) as LaunchRun;
		});
		const expectedId = duplicates
			.map((duplicate) => duplicate.id)
			.sort()
			.at(-1);

		await coordinator.reconcileIncomplete();

		expect(repos.launchRuns.getById(expectedId as string)?.status).not.toBe("cancelled");
		expect(
			duplicates.filter(
				(duplicate) =>
					duplicate.id !== expectedId &&
					repos.launchRuns.getById(duplicate.id)?.status === "cancelled",
			),
		).toHaveLength(1);
	});

	it("prefers the latest startup retry over newer non-retry runs", async () => {
		const { coordinator, process, repos } = createWatcherHarness();
		const retry = await coordinator.retryStartup(process.id, SYSTEM_ACTOR);
		const newer = repos.launchRuns.create({
			launcherId: "demo.ui",
			origin: "ui",
			steps: startupSteps,
		});
		repos.launchRuns.update(newer.id, (run) => ({
			...run,
			instanceId: process.id,
			status: "starting",
		}));

		await coordinator.reconcileIncomplete();

		expect(repos.launchRuns.getById(retry.launchRunId)?.status).not.toBe("cancelled");
		expect(repos.launchRuns.getById(newer.id)?.status).toBe("cancelled");
	});

	it("does not relaunch a watcher after its process was committed", async () => {
		const { coordinator, process, repos } = createWatcherHarness();
		const failed = repos.launchRuns.create({
			launcherId: "demo.issues",
			idempotencyKey: "watcher:demo:committed",
			origin: "watcher",
			steps: startupSteps,
		});
		repos.launchRuns.update(failed.id, (run) => ({
			...run,
			instanceId: process.id,
			status: "failed",
			completedAt: new Date().toISOString(),
		}));
		const resolveLaunchAttempt = vi.fn();

		const result = await coordinator.startWatcher(
			{
				processId: "demo",
				watcherId: "issues",
				resolveLaunchAttempt,
			} as never,
			{},
			{ idempotencyKey: "watcher:demo:committed", actor: SYSTEM_ACTOR },
		);

		expect(result).toMatchObject({
			launchRunId: failed.id,
			process: { id: process.id },
			error: "The previous launch attempt failed.",
		});
		expect(resolveLaunchAttempt).not.toHaveBeenCalled();
	});
});
