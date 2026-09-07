import { type LaunchRun, SYSTEM_ACTOR } from "@leitwerk-dev/domain";
import { expect, vi } from "vitest";
import { createInMemoryDatabase } from "./db/database.js";
import { createAllRepos } from "./db/repositories.js";
import { createLaunchCoordinator } from "./launch-coordinator.js";
import { createLaunchPipeline, initialLaunchSteps } from "./launch-pipeline.js";
import type { ProcessLaunchPlanExecutor } from "./process-launch-executor.js";

export const startupSteps = initialLaunchSteps()
	.filter(
		(step) => !["validate_request", "resolve_models_skills", "create_process"].includes(step.id),
	)
	.map((step) => ({
		...step,
		status: (["start_worker", "connect_worker"].includes(step.id) ? "completed" : "in_progress") as
			| "completed"
			| "in_progress",
	}));

export function expectLaunchStep(
	run: LaunchRun | null | undefined,
	id: string,
	status: string,
	safeSummary?: unknown,
) {
	expect(run?.steps.find((step) => step.id === id)).toMatchObject({
		status,
		...(safeSummary !== undefined ? { safeSummary } : {}),
	});
}

export function createCoordinatorHarness(
	input: {
		resolve?: () => Promise<unknown>;
		checks?: readonly unknown[];
		prepare?: () => Promise<unknown>;
		commit?: () => Promise<unknown>;
		processLaunches?: Record<string, unknown>;
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
	const processLaunches = input.processLaunches ?? {};
	const createProcessFromLaunchPlan: ProcessLaunchPlanExecutor = (launchPlan, opts) => {
		const executor = processLaunches.createProcessFromLaunchPlan as
			| ProcessLaunchPlanExecutor
			| undefined;
		if (!executor) throw new Error("createProcessFromLaunchPlan test double is not configured");
		return executor(launchPlan, opts);
	};
	const coordinator = createLaunchCoordinator({
		...repos,
		commands: { run: vi.fn() } as never,
		launcherService: {
			resolveUiLauncher: input.resolve ?? (async () => ({ ok: true, launcher: resolvedLauncher })),
			resolvePreparationChecks: () => input.checks ?? [],
		} as never,
		futureExecutionLifecycle: { prepareLaunch, commitPreparedLaunch } as never,
		launchPipeline: createLaunchPipeline({ launchRuns: repos.launchRuns, broadcaster }),
		launchPlans: {} as never,
		createProcessFromLaunchPlan,
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
		processLaunches,
		run: () => repos.launchRuns.getByIdempotencyKey(request.idempotencyKey),
		runProgrammatic: () =>
			coordinator.startProgrammatic(
				{ launcherId: request.launcherId, launcherInput: request.request.launcherInput },
				{ idempotencyKey: request.idempotencyKey, actor: request.actor },
			),
	};
}

export function createWatcherHarness(
	overrides: { launchPlans?: unknown; processLaunches?: unknown } = {},
) {
	const repos = createAllRepos(createInMemoryDatabase());
	const process = repos.processes.create({
		processId: "demo",
		selectedTurnId: "start",
		lifecycleStatus: "active",
	});
	repos.leases.create({ instanceId: process.id, workerId: "wrk_current", state: "spawning" });
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
	const launchPlans = (overrides.launchPlans ?? {}) as Record<string, unknown>;
	const processLaunches = (overrides.processLaunches ?? {}) as Record<string, unknown>;
	const createProcessFromLaunchPlan: ProcessLaunchPlanExecutor = (launchPlan, opts) => {
		const executor = processLaunches.createProcessFromLaunchPlan as
			| ProcessLaunchPlanExecutor
			| undefined;
		if (!executor) throw new Error("createProcessFromLaunchPlan test double is not configured");
		return executor(launchPlan, opts);
	};
	const coordinator = createLaunchCoordinator({
		...repos,
		commands: { run: vi.fn() } as never,
		launcherService: {} as never,
		futureExecutionLifecycle: {} as never,
		launchPipeline: createLaunchPipeline({ launchRuns: repos.launchRuns, broadcaster }),
		launchPlans: launchPlans as never,
		createProcessFromLaunchPlan,
	});
	const run = () => repos.launchRuns.getById(created.id) as LaunchRun;
	return { broadcaster, coordinator, process, repos, run, launchPlans, processLaunches };
}
