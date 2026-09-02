import { type LaunchChecklistStep, type LaunchRun, SYSTEM_ACTOR } from "@leitwerk-dev/domain";
import { SafeLaunchPreparationError } from "@leitwerk-dev/process-sdk";
import { describe, expect, it, vi } from "vitest";
import { createInMemoryDatabase } from "./db/database.js";
import { createAllRepos } from "./db/repositories.js";
import { createLaunchCoordinator } from "./launch-coordinator.js";
import { createLaunchPipeline } from "./launch-pipeline.js";

const startupSteps: LaunchChecklistStep[] = [
	{ id: "choose_title", label: "Choose process title", status: "in_progress" },
	{ id: "start_worker", label: "Start worker", status: "completed" },
	{ id: "connect_worker", label: "Connect worker", status: "completed" },
	{ id: "prepare_workspace", label: "Prepare workspace", status: "in_progress" },
	{ id: "start_first_turn", label: "Start first turn", status: "in_progress" },
];

function createUiHarness(
	input: {
		resolve?: () => Promise<unknown>;
		checks?: readonly unknown[];
		prepare?: () => Promise<unknown>;
		commit?: () => Promise<unknown>;
	} = {},
) {
	const repos = createAllRepos(createInMemoryDatabase());
	const broadcaster = { sendDurable: vi.fn() } as never;
	const resolvedLauncher = {
		processId: "demo",
		launcherId: "demo.ui",
		launchConfig: { processId: "demo", params: {} },
		launchPlan: {
			processId: "demo",
			processInput: { metadata: { existing: true } },
			startTurnId: null,
		},
	};
	const prepareLaunch = vi.fn(
		input.prepare ??
			(async () => ({
				ok: true,
				prepared: { launchPlan: resolvedLauncher.launchPlan },
			})),
	);
	const commitPreparedLaunch = vi.fn(
		input.commit ??
			(async () => {
				const process = repos.processes.create({ processId: "demo" });
				return { kind: "launched", process, projects: [], operation: "created" };
			}),
	);
	const coordinator = createLaunchCoordinator({
		...repos,
		launcherService: {
			resolveUiLauncher: input.resolve ?? (async () => ({ ok: true, launcher: resolvedLauncher })),
			resolvePreparationChecks: () => input.checks ?? [],
		} as never,
		futureExecutionLifecycle: { prepareLaunch, commitPreparedLaunch } as never,
		launchPipeline: createLaunchPipeline({ launchRuns: repos.launchRuns, broadcaster }),
		broadcaster,
	});
	const request = {
		launcherId: "demo.ui",
		idempotencyKey: `ui-test:${crypto.randomUUID()}`,
		request: {
			title: null,
			titleProvided: false,
			launcherInput: {},
			launcherInputProvided: true,
			modelConfig: {},
			modelConfigProvided: false,
			schedule: { mode: "now" as const },
			scheduleProvided: true,
		},
		actor: SYSTEM_ACTOR,
	};
	return {
		coordinator,
		commitPreparedLaunch,
		prepareLaunch,
		repos,
		request,
		run: () => repos.launchRuns.getByIdempotencyKey(request.idempotencyKey),
		runProgrammatic: () =>
			coordinator.startProgrammatic(
				{ launcherId: request.launcherId, launcherInput: request.request.launcherInput },
				{ idempotencyKey: request.idempotencyKey, actor: request.actor },
			),
	};
}

function fixture() {
	const repos = createAllRepos(createInMemoryDatabase());
	const process = repos.processes.create({
		processId: "demo",
		selectedTurnId: "start",
		lifecycleStatus: "running",
	});
	repos.leases.create({ instanceId: process.id, workerId: "wrk_current", state: "starting" });
	const created = repos.launchRuns.create({
		launcherId: "demo.ui",
		origin: "ui",
		steps: startupSteps,
	});
	repos.launchRuns.update(created.id, (run) => ({
		...run,
		instanceId: process.id,
		status: "starting",
	}));
	const broadcaster = { sendDurable: vi.fn() } as never;
	const coordinator = createLaunchCoordinator({
		...repos,
		launcherService: {} as never,
		futureExecutionLifecycle: {} as never,
		launchPipeline: createLaunchPipeline({ launchRuns: repos.launchRuns, broadcaster }),
		broadcaster,
	});
	const run = () => repos.launchRuns.getById(created.id) as LaunchRun;
	return { coordinator, process, repos, run };
}

describe("LaunchCoordinator UI adapter failures", () => {
	it("records launcher resolution failures at request validation", async () => {
		const harness = createUiHarness({
			resolve: async () => ({
				ok: false,
				errors: [{ code: "invalid_input", message: "Repository is required" }],
			}),
		});

		const result = await harness.runProgrammatic();

		expect(result).toMatchObject({ process: null, error: "Repository is required" });
		expect(harness.prepareLaunch).not.toHaveBeenCalled();
		expect(harness.run()).toMatchObject({
			status: "failed",
			steps: expect.arrayContaining([
				expect.objectContaining({ id: "validate_request", status: "failed" }),
			]),
		});
	});

	it("stops after a safe preparation-check failure", async () => {
		const harness = createUiHarness({
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
		expect(harness.run()).toMatchObject({
			status: "failed",
			steps: expect.arrayContaining([
				expect.objectContaining({
					id: "check:repository_access",
					status: "failed",
					safeSummary: "Authorize repository access, then retry.",
				}),
			]),
		});
	});

	it("records launch preparation failures before process creation", async () => {
		const harness = createUiHarness({
			prepare: async () => ({
				ok: false,
				outcome: {
					kind: "invalid",
					issues: [{ code: "invalid_model_config", message: "Model unavailable" }],
				},
			}),
		});

		const result = await harness.runProgrammatic();

		expect(result).toMatchObject({ process: null, error: "Model unavailable" });
		expect(harness.commitPreparedLaunch).not.toHaveBeenCalled();
		expect(harness.repos.processes.listAll()).toHaveLength(0);
		expect(harness.run()).toMatchObject({
			status: "failed",
			steps: expect.arrayContaining([
				expect.objectContaining({ id: "resolve_models_skills", status: "failed" }),
			]),
		});
	});

	it("records pre-commit creation failures without a process", async () => {
		const harness = createUiHarness({
			commit: async () => ({
				kind: "failed",
				issue: { code: "process_launch_failed", message: "Database unavailable" },
			}),
		});

		const result = await harness.runProgrammatic();

		expect(result).toMatchObject({ process: null, error: "Database unavailable" });
		expect(harness.repos.processes.listAll()).toHaveLength(0);
		expect(harness.run()).toMatchObject({
			instanceId: null,
			status: "failed",
			steps: expect.arrayContaining([
				expect.objectContaining({ id: "create_process", status: "failed" }),
			]),
		});
	});
});

describe("LaunchCoordinator programmatic admission", () => {
	it("creates one durable run and merges trusted process metadata", async () => {
		const harness = createUiHarness();
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

describe("LaunchCoordinator observations", () => {
	it("keeps replayed bootstrap phases monotonic", () => {
		const { coordinator, process, run } = fixture();
		coordinator.observeBootstrapProgress(process.id, "wrk_current", "preparing_turn");
		expect(run().steps.find((step) => step.id === "prepare_workspace")?.status).toBe("completed");

		coordinator.observeBootstrapProgress(process.id, "wrk_current", "loading_resources");
		expect(run().steps.find((step) => step.id === "prepare_workspace")?.status).toBe("completed");
	});

	it("ignores observations from a replaced worker lease", () => {
		const { coordinator, process, run } = fixture();
		const revision = run().revision;
		coordinator.observeRunnerPhase(process.id, "wrk_stale", "starting_runtime");
		expect(run().revision).toBe(revision);
	});

	it("waits for concurrent title generation before completing the run", () => {
		const { coordinator, process, run } = fixture();
		coordinator.observeWorkerReady(process.id, "wrk_current");
		coordinator.observeFirstTurnStarted(process.id, "wrk_current");
		expect(run().status).toBe("starting");
		expect(run().steps.find((step) => step.id === "choose_title")?.status).toBe("in_progress");

		coordinator.observeTitle(process.id, "completed");
		expect(run().status).toBe("completed");
	});

	it("correlates title outcomes to the recorded launch run", () => {
		const { coordinator, process, run } = fixture();
		coordinator.observeTitle(process.id, "skipped", undefined, run().id);
		expect(run().steps.find((step) => step.id === "choose_title")?.status).toBe("skipped");
	});

	it("resumes a pre-commit UI launch from its server-private replay", async () => {
		const repos = createAllRepos(createInMemoryDatabase());
		const run = repos.launchRuns.create({
			launcherId: "demo.ui",
			origin: "ui",
			steps: [
				{ id: "validate_request", label: "Validate launch request", status: "in_progress" },
				{ id: "resolve_models_skills", label: "Resolve models and skills", status: "pending" },
				{ id: "create_process", label: "Create process", status: "pending" },
				{ id: "choose_title", label: "Choose process title", status: "pending" },
				{ id: "start_worker", label: "Start worker", status: "pending" },
				{ id: "connect_worker", label: "Connect worker", status: "pending" },
				{ id: "prepare_workspace", label: "Prepare workspace", status: "pending" },
				{ id: "start_first_turn", label: "Start first turn", status: "pending" },
			],
		});
		const request = {
			launcherId: "demo.ui",
			request: {
				title: null,
				titleProvided: false,
				launcherInput: {},
				modelConfig: {},
				modelConfigProvided: false,
				schedule: { mode: "now" },
				skillIds: [],
			},
			actor: SYSTEM_ACTOR,
		};
		repos.launchRuns.saveReplay(run.id, request);
		const commitPreparedLaunch = vi.fn(async () => {
			const process = repos.processes.create({
				processId: "demo",
				selectedTurnId: null,
				lifecycleStatus: "completed",
			});
			return { kind: "launched" as const, process, projects: [], operation: "created" as const };
		});
		const broadcaster = { sendDurable: vi.fn() } as never;
		const coordinator = createLaunchCoordinator({
			...repos,
			launcherService: {
				resolveUiLauncher: vi.fn(async () => ({
					ok: true,
					launcher: {
						launchConfig: { params: {} },
						launchPlan: { startTurnId: null },
					},
				})),
			} as never,
			futureExecutionLifecycle: {
				prepareLaunch: vi.fn(async () => ({
					ok: true,
					prepared: { launchPlan: { startTurnId: null } },
				})),
				commitPreparedLaunch,
			} as never,
			launchPipeline: createLaunchPipeline({ launchRuns: repos.launchRuns, broadcaster }),
			broadcaster,
		});

		await coordinator.reconcileIncomplete();

		expect(commitPreparedLaunch).toHaveBeenCalledOnce();
		expect(repos.launchRuns.getById(run.id)).toMatchObject({
			instanceId: expect.stringMatching(/^agt_/),
			status: "completed",
		});
		expect(repos.launchRuns.getReplay(run.id)).toBeNull();
	});

	it("does not replay process creation after a correlated commit", async () => {
		const repos = createAllRepos(createInMemoryDatabase());
		const process = repos.processes.create({ processId: "demo" });
		const broadcaster = { sendDurable: vi.fn() } as never;
		const pipeline = createLaunchPipeline({ launchRuns: repos.launchRuns, broadcaster });
		const opened = pipeline.open({
			launcherId: "demo.ui",
			idempotencyKey: "ui:committed-before-restart",
			origin: "ui",
		});
		repos.launchRuns.update(opened.launchRunId, (run) => ({
			...run,
			instanceId: process.id,
			status: "process_created",
		}));
		repos.launchRuns.saveReplay(opened.launchRunId, {
			launcherId: "demo.ui",
			request: { schedule: { mode: "now" }, launcherInput: {} },
			actor: SYSTEM_ACTOR,
		});
		const commitPreparedLaunch = vi.fn();
		const coordinator = createLaunchCoordinator({
			...repos,
			launcherService: {} as never,
			futureExecutionLifecycle: { commitPreparedLaunch } as never,
			launchPipeline: pipeline,
			broadcaster,
		});

		await coordinator.reconcileIncomplete();

		expect(commitPreparedLaunch).not.toHaveBeenCalled();
		expect(repos.processes.listAll()).toEqual([expect.objectContaining({ id: process.id })]);
		expect(repos.launchRuns.getById(opened.launchRunId)).toMatchObject({
			instanceId: process.id,
		});
	});

	it("retains safe watcher remediation without committing a process", async () => {
		const { coordinator } = fixture();
		const createProcess = vi.fn();
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
			{
				launchPlans: { prepare: vi.fn() },
				processLaunches: {
					createProcessFromLaunchConfig: vi.fn(),
					createProcessFromLaunchPlan: createProcess,
				},
			},
		);

		expect(result).toMatchObject({
			process: null,
			error: "Authorize repository access, then retry.",
		});
		expect(createProcess).not.toHaveBeenCalled();
	});

	it("keeps the stable watcher key and cancels deduplicated startup progress", async () => {
		const { coordinator, process, repos } = fixture();
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
				createProcessFromLaunchConfig: vi.fn(),
				createProcessFromLaunchPlan: createProcess,
			},
		};
		const request = { idempotencyKey: "watcher:demo:retry", actor: SYSTEM_ACTOR };

		const retried = await coordinator.startWatcher(watcher, {}, request, services as never);
		const replayed = await coordinator.startWatcher(watcher, {}, request, services as never);

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
		const { coordinator, process, repos } = fixture();
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
			{
				launchPlans: { prepare: async (launchPlan: unknown) => ({ ok: true, launchPlan }) },
				processLaunches: {
					createProcessFromLaunchPlan: async () => ({
						ok: true,
						process,
						projects: [],
						reused: true,
					}),
				},
			} as never,
		);

		expect(result.process).toMatchObject({ id: process.id });
		expect(repos.launchRuns.getById(result.launchRunId)).toMatchObject({
			status: "failed",
			steps: expect.arrayContaining([
				expect.objectContaining({
					id: "start_worker",
					status: "failed",
					safeSummary: expect.stringContaining("has not started a worker"),
				}),
			]),
		});
	});

	it("cancels stale duplicate watcher launch runs during reconciliation", async () => {
		const { coordinator, process, repos, run } = fixture();
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

		expect(run().status).not.toBe("cancelled");
		expect(
			duplicates.filter(
				(duplicate) => repos.launchRuns.getById(duplicate.id)?.status === "cancelled",
			),
		).toHaveLength(172);
	});

	it("does not relaunch a watcher after its process was committed", async () => {
		const { coordinator, process, repos } = fixture();
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
			{} as never,
		);

		expect(result).toMatchObject({
			launchRunId: failed.id,
			process: { id: process.id },
			error: "The previous launch attempt failed.",
		});
		expect(resolveLaunchAttempt).not.toHaveBeenCalled();
	});
});
