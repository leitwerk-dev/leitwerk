import type {
	Actor,
	LaunchChecklistStep,
	LaunchChecklistStepStatus,
	LaunchRun,
	ProcessInstance,
} from "@leitwerk-dev/domain";
import {
	type LaunchPreparationCheck,
	type ProcessLaunchConfig,
	type ProcessLaunchExecutorLike,
	type ProcessLauncherService,
	type ProcessLaunchPlanServiceLike,
	type RegisteredProcessWatcherLike,
	SafeLaunchPreparationError,
} from "@leitwerk-dev/process-sdk";
import type { WorkerBootstrapProgressPayload } from "@leitwerk-dev/worker-protocol";
import type { WorkerStartPhase } from "@leitwerk-dev/worker-runners/types";
import type { RepositoryBundle } from "./db/repositories.js";
import type {
	FutureExecutionLifecycle,
	LaunchMutationOutcome,
	NormalizedScheduledLaunchInput,
} from "./future-execution/index.js";
import type { Broadcaster } from "./ws/broadcast.js";

const CORE_STEPS = [
	["validate_request", "Validate launch request"],
	["resolve_models_skills", "Resolve models and skills"],
	["create_process", "Create process"],
	["choose_title", "Choose process title"],
	["start_worker", "Start worker"],
	["connect_worker", "Connect worker"],
	["prepare_workspace", "Prepare workspace"],
	["start_first_turn", "Start first turn"],
] as const;

const STATUS_RANK: Record<LaunchChecklistStepStatus, number> = {
	pending: 0,
	in_progress: 1,
	completed: 2,
	skipped: 2,
	failed: 2,
};

const STARTUP_STEP_IDS = [
	"start_worker",
	"connect_worker",
	"prepare_workspace",
	"start_first_turn",
] as const;

const NOOP_LAUNCH_LOGGER = { info() {}, warn() {} };

export interface StartLaunchRequest {
	launcherId: string;
	idempotencyKey?: string | null;
	request: NormalizedScheduledLaunchInput;
	actor: Actor;
}

export interface LaunchCoordinator {
	start(request: StartLaunchRequest): Promise<{ launchRunId: string }>;
	startBlocking(request: StartLaunchRequest): Promise<LaunchMutationOutcome>;
	startWatcher<TConfig, TEvent>(
		watcher: RegisteredProcessWatcherLike<TConfig, TEvent>,
		event: TEvent,
		request: { idempotencyKey: string; actor: Actor },
		services: {
			launchPlans: ProcessLaunchPlanServiceLike;
			processLaunches: ProcessLaunchExecutorLike;
		},
	): Promise<{ launchRunId: string; process: ProcessInstance | null; error: string | null }>;
	beginScheduled(launcherId: string | null, idempotencyKey: string): { launchRunId: string };
	observeScheduledPrepared(launchRunId: string): void;
	observeScheduledCommitted(
		launchRunId: string,
		process: ProcessInstance,
		startTurnId: string | null,
		reactionError?: string,
	): void;
	failScheduled(launchRunId: string, stepId: string, safeSummary: string): void;
	retryStartup(instanceId: string, actor: Actor): Promise<{ launchRunId: string }>;
	failStartupRetry(instanceId: string, safeSummary: string): void;
	observeRunnerPhase(instanceId: string, workerId: string, phase: WorkerStartPhase): void;
	observeBootstrapProgress(
		instanceId: string,
		workerId: string,
		phase: WorkerBootstrapProgressPayload["phase"],
	): void;
	observeWorkerReady(instanceId: string, workerId: string): void;
	observeFirstTurnStarted(instanceId: string, workerId: string): void;
	observeWorkerFailure(instanceId: string, workerId: string, safeSummary: string): void;
	observeTitle(
		instanceId: string,
		status: "completed" | "skipped" | "failed",
		safeSummary?: string,
		launchRunId?: string | null,
	): void;
	reconcileIncomplete(): Promise<void>;
}

interface LaunchCoordinatorDeps {
	launchRuns: RepositoryBundle["launchRuns"];
	processes: RepositoryBundle["processes"];
	leases: RepositoryBundle["leases"];
	turnRecords: RepositoryBundle["turnRecords"];
	titleJobs: RepositoryBundle["titleJobs"];
	launcherService: ProcessLauncherService;
	futureExecutionLifecycle: FutureExecutionLifecycle;
	broadcaster: Broadcaster;
	titleGenerationAvailable?: boolean;
	logger?: { info(message: string): void; warn(message: string): void };
}

function step(id: string, label: string): LaunchChecklistStep {
	return { id, label, status: "pending" };
}

function transitionStep(
	run: LaunchRun,
	id: string,
	status: LaunchChecklistStepStatus,
	safeSummary?: string,
): LaunchRun {
	const timestamp = new Date().toISOString();
	return {
		...run,
		steps: run.steps.map((item) => {
			if (item.id !== id || STATUS_RANK[status] < STATUS_RANK[item.status]) return item;
			if (STATUS_RANK[status] === STATUS_RANK[item.status] && item.status !== status) return item;
			return {
				...item,
				status,
				...(status === "in_progress" && !item.startedAt ? { startedAt: timestamp } : {}),
				...(["completed", "failed", "skipped"].includes(status) && !item.completedAt
					? { completedAt: timestamp }
					: {}),
				...(safeSummary ? { safeSummary } : {}),
			};
		}),
	};
}

function initialSteps(): LaunchChecklistStep[] {
	return CORE_STEPS.map(([id, label]) => step(id, label));
}

function withPreparationChecks(
	run: LaunchRun,
	checks: readonly LaunchPreparationCheck[],
): LaunchRun {
	if (checks.length === 0) return run;
	return {
		...run,
		steps: [
			run.steps[0] as LaunchChecklistStep,
			...checks.map(
				(check) =>
					run.steps.find((item) => item.id === `check:${check.id}`) ??
					step(`check:${check.id}`, check.label),
			),
			...run.steps.slice(1).filter((item) => !item.id.startsWith("check:")),
		],
	};
}

function finishRun(run: LaunchRun, status: "failed" | "cancelled"): LaunchRun {
	return { ...run, status, completedAt: run.completedAt ?? new Date().toISOString() };
}

function failRun(run: LaunchRun, stepId: string, summary: string): LaunchRun {
	return finishRun(transitionStep(run, stepId, "failed", summary), "failed");
}

function titleStepStatus(
	process: Pick<ProcessInstance, "title">,
	titleGenerationAvailable: boolean | undefined,
): LaunchChecklistStepStatus {
	return process.title ? "completed" : titleGenerationAvailable ? "in_progress" : "skipped";
}

function skipStartupSteps(run: LaunchRun): LaunchRun {
	let next = run;
	for (const id of STARTUP_STEP_IDS) next = transitionStep(next, id, "skipped");
	return next;
}

function startupComplete(run: LaunchRun): boolean {
	const required = run.steps.filter((item) =>
		[...STARTUP_STEP_IDS, "choose_title"].includes(item.id as (typeof STARTUP_STEP_IDS)[number]),
	);
	return required.every((item) => ["completed", "skipped", "failed"].includes(item.status));
}

function completeWhenReady(run: LaunchRun): LaunchRun {
	if (run.status === "failed" || run.status === "cancelled") return run;
	if (!startupComplete(run)) return { ...run, status: "starting" };
	return {
		...run,
		status: "completed",
		completedAt: run.completedAt ?? new Date().toISOString(),
	};
}

export function createLaunchCoordinator(deps: LaunchCoordinatorDeps): LaunchCoordinator {
	function broadcast(run: LaunchRun): void {
		deps.broadcaster.sendDurable(
			"launch.updated",
			{ launchRunId: run.id, instanceId: run.instanceId },
			run.instanceId ?? undefined,
		);
	}

	function mutate(id: string, fn: (run: LaunchRun) => LaunchRun): LaunchRun {
		const run = deps.launchRuns.update(id, fn);
		if (!run) throw new Error(`Launch run '${id}' does not exist`);
		broadcast(run);
		return run;
	}

	function createRun(input: {
		launcherId: string | null;
		idempotencyKey?: string | null;
		origin: LaunchRun["origin"];
		broadcastCreated?: boolean;
	}): LaunchRun {
		const { broadcastCreated = true, ...createInput } = input;
		const run = deps.launchRuns.create({ ...createInput, steps: initialSteps() });
		if (broadcastCreated) broadcast(run);
		return run;
	}

	function fail(runId: string, stepId: string, summary: string): void {
		mutate(runId, (run) => failRun(run, stepId, summary));
	}

	async function runPreparationChecks(
		runId: string,
		checks: readonly LaunchPreparationCheck[],
		launchConfig: ProcessLaunchConfig,
	): Promise<string | null> {
		const controller = new AbortController();
		for (const check of checks) {
			const id = `check:${check.id}`;
			mutate(runId, (run) => transitionStep(run, id, "in_progress"));
			try {
				await check.run({
					signal: controller.signal,
					launchConfig,
					logger: deps.logger ?? NOOP_LAUNCH_LOGGER,
				});
				mutate(runId, (run) => transitionStep(run, id, "completed"));
			} catch (error) {
				controller.abort();
				const summary =
					error instanceof SafeLaunchPreparationError
						? error.safeSummary
						: "The preparation check did not complete. Verify access and try again.";
				fail(runId, id, summary);
				return summary;
			}
		}
		return null;
	}

	function currentRun(instanceId: string, includeCompletedTitle = false): LaunchRun | null {
		return (
			[...deps.launchRuns.listByInstance(instanceId)]
				.reverse()
				.find(
					(run) =>
						["preparing", "process_created", "starting"].includes(run.status) ||
						(includeCompletedTitle &&
							run.steps.some(
								(item) => item.id === "choose_title" && item.status === "in_progress",
							)),
				) ?? null
		);
	}

	function mutateCurrent(
		instanceId: string,
		workerId: string | null,
		fn: (run: LaunchRun) => LaunchRun,
		includeCompletedTitle = false,
	): LaunchRun | null {
		if (workerId && deps.leases.getByInstance(instanceId)?.workerId !== workerId) return null;
		const run = currentRun(instanceId, includeCompletedTitle);
		return run ? mutate(run.id, fn) : null;
	}

	async function execute(runId: string, input: StartLaunchRequest): Promise<LaunchMutationOutcome> {
		try {
			mutate(runId, (run) => transitionStep(run, "validate_request", "in_progress"));
			if (input.request.schedule.mode !== "now") {
				fail(runId, "validate_request", "Use the scheduling controls to save a future launch.");
				return deps.futureExecutionLifecycle.scheduleLaunch(input.launcherId, input.request, {
					actor: input.actor,
				});
			}
			const resolved = await deps.launcherService.resolveUiLauncher(
				input.launcherId,
				input.request.launcherInput,
			);
			if (!resolved.ok) {
				fail(runId, "validate_request", "Review the highlighted launcher fields and try again.");
				return deps.futureExecutionLifecycle.scheduleLaunch(input.launcherId, input.request, {
					actor: input.actor,
				});
			}
			mutate(runId, (run) => transitionStep(run, "validate_request", "completed"));

			const checks =
				deps.launcherService.resolvePreparationChecks?.(
					input.launcherId,
					input.request.launcherInput,
					resolved.launcher.launchConfig,
				) ?? [];
			mutate(runId, (run) => withPreparationChecks(run, checks));
			if (await runPreparationChecks(runId, checks, resolved.launcher.launchConfig)) {
				return {
					kind: "invalid",
					issues: [{ code: "preparation_failed", message: "Launch preparation failed" }],
				};
			}

			mutate(runId, (run) => transitionStep(run, "resolve_models_skills", "in_progress"));
			const result = await deps.futureExecutionLifecycle.scheduleLaunch(
				input.launcherId,
				input.request,
				{
					actor: input.actor,
					launchRunId: runId,
					resolvedLauncher: resolved.launcher,
				},
			);
			if (result.kind === "committed_with_reaction_error" && "process" in result) {
				mutate(runId, (run) => {
					let next = transitionStep(run, "resolve_models_skills", "completed");
					next = transitionStep(next, "create_process", "completed");
					return failRun(
						{ ...next, instanceId: result.process.id },
						"start_worker",
						"Process was created, but the worker could not be started cleanly. Review the process error and retry startup.",
					);
				});
				return result;
			}
			if (result.kind !== "launched") {
				fail(
					runId,
					"resolve_models_skills",
					result.kind === "invalid"
						? "Review the launch configuration and try again."
						: "The process could not be prepared. Check availability and try again.",
				);
				return result;
			}
			mutate(runId, (run) => {
				let next = transitionStep(run, "resolve_models_skills", "completed");
				next = transitionStep(next, "create_process", "completed");
				const titleStep = next.steps.find((item) => item.id === "choose_title");
				if (titleStep?.status === "pending" || titleStep?.status === "in_progress") {
					next = transitionStep(
						next,
						"choose_title",
						titleStepStatus(result.process, deps.titleGenerationAvailable),
					);
				}
				if (!resolved.launcher.launchPlan.startTurnId) next = skipStartupSteps(next);
				return completeWhenReady({ ...next, instanceId: result.process.id, status: "starting" });
			});
			return result;
		} catch {
			const current = deps.launchRuns.getById(runId);
			const failedStep =
				current?.steps.find((item) => item.status === "in_progress")?.id ?? "validate_request";
			fail(runId, failedStep, "The launch could not be completed. Try again.");
			throw new Error("The launch could not be completed");
		} finally {
			deps.launchRuns.deleteReplay(runId);
		}
	}

	return {
		async start(input) {
			const existing = input.idempotencyKey
				? deps.launchRuns.getByIdempotencyKey(input.idempotencyKey)
				: null;
			if (existing) return { launchRunId: existing.id };
			const run = createRun({
				launcherId: input.launcherId,
				idempotencyKey: input.idempotencyKey,
				origin: "ui",
			});
			deps.launchRuns.saveReplay(run.id, input);
			setTimeout(() => {
				void execute(run.id, input).catch(() => {
					deps.logger?.warn(`Launch run '${run.id}' failed unexpectedly`);
				});
			}, 0);
			return { launchRunId: run.id };
		},

		async startBlocking(input) {
			const run = createRun({
				launcherId: input.launcherId,
				idempotencyKey: input.idempotencyKey,
				origin: "ui",
			});
			deps.launchRuns.saveReplay(run.id, input);
			return execute(run.id, input);
		},

		async startWatcher(watcher, event, request, services) {
			const existing = deps.launchRuns.getByIdempotencyKey(request.idempotencyKey);
			if (existing && (existing.instanceId || !["failed", "cancelled"].includes(existing.status))) {
				return {
					launchRunId: existing.id,
					process: existing.instanceId ? deps.processes.getById(existing.instanceId) : null,
					error: existing.status === "failed" ? "The previous launch attempt failed." : null,
				};
			}
			if (existing) deps.launchRuns.archiveIdempotencyKey(existing.id, request.idempotencyKey);
			const created = createRun({
				launcherId: `${watcher.processId}.${watcher.watcherId}`,
				idempotencyKey: request.idempotencyKey,
				origin: "watcher",
			});
			const failWatcher = (stepId: string, summary: string) => {
				fail(created.id, stepId, summary);
				return { launchRunId: created.id, process: null, error: summary };
			};
			try {
				mutate(created.id, (run) => transitionStep(run, "validate_request", "in_progress"));
				const attempt = await watcher.resolveLaunchAttempt(event);
				if (!attempt) {
					mutate(created.id, (run) =>
						finishRun(transitionStep(run, "validate_request", "skipped"), "cancelled"),
					);
					return { launchRunId: created.id, process: null, error: null };
				}
				mutate(created.id, (run) =>
					withPreparationChecks(
						transitionStep(run, "validate_request", "completed"),
						attempt.preparationChecks,
					),
				);
				const preparationError = await runPreparationChecks(
					created.id,
					attempt.preparationChecks,
					attempt.launchConfig,
				);
				if (preparationError) {
					return { launchRunId: created.id, process: null, error: preparationError };
				}
				mutate(created.id, (run) => transitionStep(run, "resolve_models_skills", "in_progress"));
				const prepared = await services.launchPlans.prepare(
					{ ...attempt.launchPlan, handoffDedupKey: request.idempotencyKey },
					{ modelConfig: watcher.launchModelConfig, invalidModelConfig: "omit" },
				);
				if (!prepared.ok) {
					return failWatcher(
						"resolve_models_skills",
						"The launch model configuration is unavailable. Review the watcher configuration.",
					);
				}
				const result = await services.processLaunches.createProcessFromLaunchPlan(
					prepared.launchPlan,
					{ actor: request.actor, launchRunId: created.id },
				);
				if (!result.ok && result.stage === "pre_commit") {
					return failWatcher(
						"create_process",
						"The process could not be created. Try again later.",
					);
				}
				const process = result.process;
				mutate(created.id, (run) => {
					let next = transitionStep(run, "resolve_models_skills", "completed");
					next = transitionStep(next, "create_process", "completed");
					next = transitionStep(
						next,
						"choose_title",
						titleStepStatus(process, deps.titleGenerationAvailable),
					);
					if (!prepared.launchPlan.startTurnId) next = skipStartupSteps(next);
					if (result.ok && result.reused) {
						const lease = deps.leases.getByInstance(process.id);
						const hasTurn = deps.turnRecords.listByInstance(process.id).length > 0;
						if (hasTurn) {
							return finishRun({ ...next, instanceId: process.id }, "cancelled");
						} else if (!lease || ["failed", "cleanup", "exited", "absent"].includes(lease.state)) {
							return failRun(
								{ ...next, instanceId: process.id },
								"start_worker",
								"The existing process has not started a worker. Retry startup from the process page.",
							);
						}
					}
					if (!result.ok) {
						return failRun(
							{ ...next, instanceId: process.id },
							"start_worker",
							"Process was created, but startup failed. Review the process error and retry startup.",
						);
					}
					return completeWhenReady({ ...next, instanceId: process.id, status: "starting" });
				});
				return {
					launchRunId: created.id,
					process,
					error: result.ok ? null : "Process startup failed.",
				};
			} catch (error) {
				const current = deps.launchRuns.getById(created.id);
				const failedStep =
					current?.steps.find((item) => item.status === "in_progress")?.id ?? "validate_request";
				return failWatcher(
					failedStep,
					error instanceof SafeLaunchPreparationError
						? error.safeSummary
						: "The watcher launch could not be completed. Try again later.",
				);
			}
		},

		beginScheduled(launcherId, idempotencyKey) {
			const existing = deps.launchRuns.getByIdempotencyKey(idempotencyKey);
			if (existing) return { launchRunId: existing.id };
			const run = createRun({
				launcherId,
				idempotencyKey,
				origin: "scheduled",
				broadcastCreated: false,
			});
			const updated = deps.launchRuns.update(run.id, (current) => {
				let next = transitionStep(current, "validate_request", "completed");
				next = transitionStep(next, "resolve_models_skills", "in_progress");
				return next;
			}) as LaunchRun;
			broadcast(updated);
			return { launchRunId: run.id };
		},

		observeScheduledPrepared(launchRunId) {
			mutate(launchRunId, (run) => {
				let next = transitionStep(run, "resolve_models_skills", "completed");
				next = transitionStep(next, "create_process", "in_progress");
				return next;
			});
		},

		observeScheduledCommitted(launchRunId, process, startTurnId, reactionError) {
			mutate(launchRunId, (run) => {
				let next = transitionStep(run, "create_process", "completed");
				next = transitionStep(
					next,
					"choose_title",
					titleStepStatus(process, deps.titleGenerationAvailable),
				);
				if (!startTurnId) next = skipStartupSteps(next);
				if (reactionError) {
					return failRun({ ...next, instanceId: process.id }, "start_worker", reactionError);
				}
				return completeWhenReady({ ...next, instanceId: process.id, status: "starting" });
			});
		},

		failScheduled(launchRunId, stepId, safeSummary) {
			fail(launchRunId, stepId, safeSummary);
		},

		async retryStartup(instanceId) {
			if (!deps.processes.getById(instanceId)) throw new Error("Process not found");
			const run = createRun({
				launcherId: null,
				origin: "startup_retry",
				broadcastCreated: false,
			});
			const updated = deps.launchRuns.update(run.id, (current) => ({
				...current,
				instanceId,
				status: "starting",
				steps: current.steps.map((item) =>
					["validate_request", "resolve_models_skills", "create_process", "choose_title"].includes(
						item.id,
					)
						? { ...item, status: "skipped" as const }
						: item,
				),
			})) as LaunchRun;
			broadcast(updated);
			return { launchRunId: run.id };
		},

		failStartupRetry(instanceId, safeSummary) {
			mutateCurrent(instanceId, null, (run) => failRun(run, "start_worker", safeSummary));
		},

		observeRunnerPhase(instanceId, workerId, phase) {
			mutateCurrent(instanceId, workerId, (run) => {
				let next: LaunchRun = { ...run, status: "starting" };
				if (phase === "preparing_runtime") {
					next = transitionStep(next, "start_worker", "in_progress");
				}
				if (phase === "starting_runtime") {
					next = transitionStep(next, "start_worker", "completed");
					next = transitionStep(next, "connect_worker", "in_progress");
				}
				return next;
			});
		},

		observeBootstrapProgress(instanceId, workerId, phase) {
			mutateCurrent(instanceId, workerId, (run) => {
				let next: LaunchRun = { ...run, status: "starting" };
				if (phase === "worker_connected") {
					next = transitionStep(next, "connect_worker", "completed");
				}
				if (phase === "preparing_workspace" || phase === "loading_resources") {
					next = transitionStep(next, "connect_worker", "completed");
					next = transitionStep(next, "prepare_workspace", "in_progress");
				}
				if (phase === "preparing_turn") {
					next = transitionStep(next, "prepare_workspace", "completed");
					next = transitionStep(next, "start_first_turn", "in_progress");
				}
				return next;
			});
		},

		observeWorkerReady(instanceId, workerId) {
			mutateCurrent(instanceId, workerId, (run) => {
				let next = transitionStep(run, "prepare_workspace", "completed");
				next = transitionStep(next, "start_first_turn", "in_progress");
				return next;
			});
		},

		observeFirstTurnStarted(instanceId, workerId) {
			mutateCurrent(instanceId, workerId, (run) =>
				completeWhenReady(transitionStep(run, "start_first_turn", "completed")),
			);
		},

		observeWorkerFailure(instanceId, workerId, safeSummary) {
			mutateCurrent(instanceId, workerId, (run) => {
				const failedStep =
					[...STARTUP_STEP_IDS]
						.reverse()
						.find((id) =>
							run.steps.some((item) => item.id === id && item.status === "in_progress"),
						) ?? "start_worker";
				return failRun(run, failedStep, safeSummary);
			});
		},

		observeTitle(instanceId, status, safeSummary, launchRunId) {
			if (launchRunId) {
				const run = deps.launchRuns.getById(launchRunId);
				if (run?.instanceId === instanceId) {
					mutate(launchRunId, (current) =>
						completeWhenReady(transitionStep(current, "choose_title", status, safeSummary)),
					);
				}
				return;
			}
			mutateCurrent(
				instanceId,
				null,
				(run) => completeWhenReady(transitionStep(run, "choose_title", status, safeSummary)),
				true,
			);
		},

		async reconcileIncomplete() {
			const incomplete = deps.launchRuns.listIncomplete();
			const authoritativeByInstance = new Map<string, LaunchRun>();
			const startupEvidenceScore = (run: LaunchRun) =>
				(run.origin === "startup_retry" ? 100 : 0) +
				run.steps
					.filter((item) => STARTUP_STEP_IDS.includes(item.id as (typeof STARTUP_STEP_IDS)[number]))
					.reduce(
						(score, item) =>
							score +
							(item.status === "completed"
								? 3
								: item.status === "in_progress"
									? 2
									: item.status === "failed"
										? 1
										: 0),
						0,
					);
			for (const run of incomplete) {
				if (!run.instanceId) continue;
				const current = authoritativeByInstance.get(run.instanceId);
				if (!current || startupEvidenceScore(run) > startupEvidenceScore(current)) {
					authoritativeByInstance.set(run.instanceId, run);
				}
			}
			for (const run of incomplete) {
				if (run.instanceId && authoritativeByInstance.get(run.instanceId)?.id !== run.id) {
					mutate(run.id, (current) => finishRun(current, "cancelled"));
					continue;
				}
				if (!run.instanceId) {
					const replay = deps.launchRuns.getReplay<StartLaunchRequest>(run.id);
					if (run.origin === "ui" && replay) {
						await execute(run.id, replay);
						continue;
					}
					mutate(run.id, (current) => ({
						...current,
						status: "failed",
						completedAt: new Date().toISOString(),
						steps: current.steps.map((item) =>
							item.status === "in_progress"
								? {
										...item,
										status: "failed",
										safeSummary: "The server restarted. Try again.",
										completedAt: new Date().toISOString(),
									}
								: item,
						),
					}));
					continue;
				}
				const process = deps.processes.getById(run.instanceId);
				if (!process) {
					mutate(run.id, (current) => finishRun(current, "cancelled"));
					continue;
				}
				const lease = deps.leases.getByInstance(run.instanceId);
				const hasTurn = deps.turnRecords.listByInstance(run.instanceId).length > 0;
				const titleJob = [...deps.titleJobs.listByProcessInstance(run.instanceId)]
					.reverse()
					.find((job) => job.launchRunId === run.id || job.launchRunId === null);
				mutate(run.id, (current) => {
					let next = transitionStep(current, "create_process", "completed");
					if (lease && ["failed", "cleanup", "exited", "absent"].includes(lease.state)) {
						const activeStep =
							[...STARTUP_STEP_IDS]
								.reverse()
								.find((id) =>
									next.steps.some((item) => item.id === id && item.status === "in_progress"),
								) ?? "start_worker";
						return failRun(
							next,
							activeStep,
							"Worker startup stopped before completion. Retry startup from the process page.",
						);
					}
					if (lease) next = transitionStep(next, "start_worker", "completed");
					if (lease && lease.state !== "spawning") {
						next = transitionStep(next, "connect_worker", "completed");
					}
					if (lease?.bootstrapReceipt) {
						next = transitionStep(next, "prepare_workspace", "completed");
					}
					if (hasTurn) next = transitionStep(next, "start_first_turn", "completed");
					if (process.title) next = transitionStep(next, "choose_title", "completed");
					else if (!deps.titleGenerationAvailable) {
						next = transitionStep(next, "choose_title", "skipped");
					} else if (titleJob?.status === "failed") {
						next = transitionStep(
							next,
							"choose_title",
							"failed",
							"Process started, but a title could not be generated. You can rename it later.",
						);
					}
					return completeWhenReady({ ...next, status: lease ? "starting" : "process_created" });
				});
			}
		},
	};
}
