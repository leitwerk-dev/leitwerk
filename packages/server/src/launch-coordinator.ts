import type { Actor, LaunchRun, ProcessInstance } from "@leitwerk-dev/domain";
import type {
	LaunchPreparationCheck,
	ProcessLauncherService,
	ProcessLaunchPlan,
	ProcessLaunchPlanServiceLike,
	ProgrammaticLaunchRequestLike,
	ProgrammaticLaunchResultLike,
	RegisteredProcessWatcherLike,
	ResolvedProcessLauncher,
} from "@leitwerk-dev/process-sdk";
import type { WorkerBootstrapProgressPayload } from "@leitwerk-dev/worker-protocol";
import type { WorkerStartPhase } from "@leitwerk-dev/worker-runners/types";
import type { RepositoryBundle } from "./db/repositories.js";
import type {
	FutureExecutionLifecycle,
	LaunchMutationOutcome,
	NormalizedScheduledLaunchInput,
	PreparedLaunch,
} from "./future-execution/index.js";
import { watcherAdmissionKey, withWatcherHandoffDedupKey } from "./launch-idempotency.js";
import {
	failLaunchRun,
	finishLaunchRun,
	initialLaunchSteps,
	type LaunchPipeline,
	type LaunchStageFailure,
} from "./launch-pipeline.js";
import {
	cancelLaunchRun,
	observeBootstrapProgress as projectBootstrapProgress,
	observeFirstTurnStarted as projectFirstTurnStarted,
	observeRunnerPhase as projectRunnerPhase,
	observeTitle as projectTitle,
	observeWorkerFailure as projectWorkerFailure,
	observeWorkerReady as projectWorkerReady,
	reconcileCommittedLaunch,
	startupEvidenceScore,
} from "./launch-run-progress.js";
import type { ProcessLaunchExecutorLike } from "./process-launch-executor.js";
import type { Broadcaster } from "./ws/broadcast.js";

const NOOP_LAUNCH_LOGGER = { info() {}, warn() {} };
const MAX_PROGRAMMATIC_METADATA_BYTES = 16 * 1024;

function isMetadataRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeProcessMetadata(
	base: Record<string, unknown> | null | undefined,
	patch: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (!patch) return base ?? undefined;
	if (Object.hasOwn(patch, "launcherId")) {
		throw new Error("Programmatic process metadata cannot overwrite server-owned launcherId");
	}
	const encoded = JSON.stringify(patch);
	if (encoded.length > MAX_PROGRAMMATIC_METADATA_BYTES) {
		throw new Error("Programmatic process metadata exceeds 16 KiB");
	}
	const merge = (left: Record<string, unknown>, right: Record<string, unknown>) => {
		const result = { ...left };
		for (const [key, value] of Object.entries(right)) {
			if (["__proto__", "constructor", "prototype"].includes(key)) {
				throw new Error("Programmatic process metadata contains a forbidden key");
			}
			result[key] =
				isMetadataRecord(result[key]) && isMetadataRecord(value)
					? merge(result[key] as Record<string, unknown>, value)
					: value;
		}
		return result;
	};
	return merge(base ?? {}, patch);
}

export interface StartLaunchRequest {
	launcherId: string;
	idempotencyKey?: string | null;
	request: NormalizedScheduledLaunchInput;
	actor: Actor;
	processMetadata?: Record<string, unknown>;
}

export interface LaunchCoordinator {
	start(request: StartLaunchRequest): Promise<{ launchRunId: string }>;
	startProgrammatic(
		request: ProgrammaticLaunchRequestLike,
		opts: { idempotencyKey: string; actor: Actor },
	): Promise<ProgrammaticLaunchResultLike>;
	startWatcher<TConfig, TEvent>(
		watcher: RegisteredProcessWatcherLike<TConfig, TEvent>,
		event: TEvent,
		request: { idempotencyKey: string; actor: Actor },
		services: {
			launchPlans: ProcessLaunchPlanServiceLike;
			processLaunches: ProcessLaunchExecutorLike;
		},
	): Promise<{ launchRunId: string; process: ProcessInstance | null; error: string | null }>;
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
	launchPipeline: LaunchPipeline;
	broadcaster: Broadcaster;
	titleGenerationAvailable?: boolean;
	logger?: { info(message: string): void; warn(message: string): void };
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
		const run = deps.launchRuns.create({ ...createInput, steps: initialLaunchSteps() });
		if (broadcastCreated) broadcast(run);
		return run;
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

	function failure<T>(safeSummary: string, value: T): LaunchStageFailure<T> {
		return { safeSummary, value };
	}

	function bindChecks(
		checks: readonly LaunchPreparationCheck[],
		launchConfig: Parameters<LaunchPreparationCheck["run"]>[0]["launchConfig"],
	) {
		return checks.map((check) => ({
			id: check.id,
			label: check.label,
			run: ({ signal, logger }: { signal: AbortSignal; logger: typeof NOOP_LAUNCH_LOGGER }) =>
				check.run({ signal, logger, launchConfig }),
		}));
	}

	async function execute(runId: string, input: StartLaunchRequest): Promise<LaunchMutationOutcome> {
		try {
			const pipelineResult = await deps.launchPipeline.run<
				StartLaunchRequest,
				ResolvedProcessLauncher,
				PreparedLaunch,
				LaunchMutationOutcome,
				unknown
			>(runId, input, {
				async resolve(request) {
					if (request.request.schedule.mode !== "now") {
						return {
							kind: "failed" as const,
							failure: failure("Use the scheduling controls to save a future launch.", {
								kind: "invalid",
								issues: [
									{
										code: "invalid_schedule",
										message: "Immediate launches require schedule mode 'now'",
									},
								],
							} as LaunchMutationOutcome),
						};
					}
					const resolved = await deps.launcherService.resolveUiLauncher(
						request.launcherId,
						request.request.launcherInput,
					);
					return resolved.ok
						? { kind: "resolved" as const, value: resolved.launcher }
						: {
								kind: "failed" as const,
								failure: failure("Review the highlighted launcher fields and try again.", {
									kind: "invalid",
									issues: resolved.errors,
								} as LaunchMutationOutcome),
							};
				},
				preparationChecks(resolved) {
					const checks =
						deps.launcherService.resolvePreparationChecks?.(
							input.launcherId,
							input.request.launcherInput,
							resolved.launchConfig,
						) ?? [];
					return bindChecks(checks, resolved.launchConfig);
				},
				preparationCheckFailure() {
					return {
						kind: "invalid",
						issues: [{ code: "preparation_failed", message: "Launch preparation failed" }],
					} as LaunchMutationOutcome;
				},
				async prepare(resolved) {
					const prepared = await deps.futureExecutionLifecycle.prepareLaunch(
						input.launcherId,
						input.request,
						{ resolvedLauncher: resolved },
					);
					return prepared.ok
						? {
								ok: true as const,
								value: input.processMetadata
									? {
											...prepared.prepared,
											launchPlan: {
												...prepared.prepared.launchPlan,
												processInput: {
													...prepared.prepared.launchPlan.processInput,
													metadata: mergeProcessMetadata(
														prepared.prepared.launchPlan.processInput.metadata,
														input.processMetadata,
													),
												},
											},
										}
									: prepared.prepared,
							}
						: {
								ok: false as const,
								failure: failure(
									"Review the launch configuration and try again.",
									prepared.outcome,
								),
							};
				},
				async commit(prepared, ctx) {
					const result = await deps.futureExecutionLifecycle.commitPreparedLaunch(prepared, {
						actor: input.actor,
						launchRunId: ctx.launchRunId,
					});
					if (result.kind === "launched") {
						return {
							kind: "committed" as const,
							result,
							process: result.process,
							startTurnId: prepared.launchPlan.startTurnId,
							reused: false,
						};
					}
					if (result.kind === "committed_with_reaction_error" && "process" in result) {
						return {
							kind: "committed_with_reaction_error" as const,
							result,
							process: result.process,
							startTurnId: prepared.launchPlan.startTurnId,
							safeSummary:
								"Process was created, but the worker could not be started cleanly. Review the process error and retry startup.",
						};
					}
					return {
						kind: "failed" as const,
						failure: failure(
							"The process could not be created. Check availability and try again.",
							result,
						),
					};
				},
				unexpectedFailure() {
					return failure("The launch could not be completed. Try again.", {
						kind: "failed",
						issue: { code: "launch_failed", message: "The launch could not be completed" },
					} as LaunchMutationOutcome);
				},
			});
			if (pipelineResult.kind === "failed")
				return pipelineResult.failure.value as LaunchMutationOutcome;
			if (pipelineResult.kind === "skipped") {
				return { kind: "failed", issue: { code: "launch_skipped", message: "Launch skipped" } };
			}
			return pipelineResult.result;
		} finally {
			deps.launchRuns.deleteReplay(runId);
		}
	}

	return {
		async start(input) {
			const opened = deps.launchPipeline.open({
				launcherId: input.launcherId,
				idempotencyKey: input.idempotencyKey,
				origin: "ui",
			});
			if (opened.existing) return { launchRunId: opened.launchRunId };
			deps.launchRuns.saveReplay(opened.launchRunId, input);
			setTimeout(() => {
				void execute(opened.launchRunId, input).catch(() => {
					deps.logger?.warn(`Launch run '${opened.launchRunId}' failed unexpectedly`);
				});
			}, 0);
			return { launchRunId: opened.launchRunId };
		},

		async startProgrammatic(request, opts) {
			mergeProcessMetadata(undefined, request.processMetadata);
			const idempotencyKey = opts.idempotencyKey.trim();
			if (!idempotencyKey) throw new Error("Programmatic launch idempotency key is required");
			const existing = deps.launchRuns.getByIdempotencyKey(idempotencyKey);
			if (existing) {
				return {
					launchRunId: existing.id,
					process: existing.instanceId ? deps.processes.getById(existing.instanceId) : null,
					error: existing.status === "failed" ? "The previous launch attempt failed." : null,
				};
			}
			const input: StartLaunchRequest = {
				launcherId: request.launcherId,
				idempotencyKey,
				request: {
					title: request.title?.trim() || null,
					titleProvided: request.title !== undefined,
					launcherInput: request.launcherInput,
					launcherInputProvided: true,
					...(request.skillIds ? { skillIds: [...request.skillIds] } : {}),
					modelConfig: request.modelConfig ?? {},
					modelConfigProvided: request.modelConfig !== undefined,
					schedule: { mode: "now" },
					scheduleProvided: true,
				},
				actor: opts.actor,
				...(request.processMetadata ? { processMetadata: request.processMetadata } : {}),
			};
			const opened = deps.launchPipeline.open({
				launcherId: request.launcherId,
				idempotencyKey,
				origin: "programmatic",
			});
			deps.launchRuns.saveReplay(opened.launchRunId, input);
			const result = await execute(opened.launchRunId, input);
			if (result.kind === "launched" || result.kind === "committed_with_reaction_error") {
				return {
					launchRunId: opened.launchRunId,
					process: "process" in result ? result.process : null,
					error: result.kind === "committed_with_reaction_error" ? result.error : null,
				};
			}
			return {
				launchRunId: opened.launchRunId,
				process: null,
				error:
					result.kind === "invalid"
						? (result.issues[0]?.message ?? "Launch input is invalid")
						: "issue" in result
							? result.issue.message
							: "The launch could not be completed",
			};
		},

		async startWatcher(watcher, event, request, services) {
			const admissionKey = watcherAdmissionKey(request.idempotencyKey);
			const existing = deps.launchRuns.getByIdempotencyKey(admissionKey);
			if (existing && (existing.instanceId || !["failed", "cancelled"].includes(existing.status))) {
				return {
					launchRunId: existing.id,
					process: existing.instanceId ? deps.processes.getById(existing.instanceId) : null,
					error: existing.status === "failed" ? "The previous launch attempt failed." : null,
				};
			}
			if (existing) deps.launchRuns.archiveIdempotencyKey(existing.id, admissionKey);
			const opened = deps.launchPipeline.open({
				launcherId: `${watcher.processId}.${watcher.watcherId}`,
				idempotencyKey: admissionKey,
				origin: "watcher",
			});
			type WatcherAttempt = {
				launchConfig: Parameters<LaunchPreparationCheck["run"]>[0]["launchConfig"];
				launchPlan: ProcessLaunchPlan;
				preparationChecks: readonly LaunchPreparationCheck[];
			};
			type WatcherResult = Awaited<
				ReturnType<ProcessLaunchExecutorLike["createProcessFromLaunchPlan"]>
			>;
			const result = await deps.launchPipeline.run<
				typeof event,
				WatcherAttempt,
				ProcessLaunchPlan,
				WatcherResult,
				unknown
			>(opened.launchRunId, event, {
				async resolve(value) {
					const attempt = await watcher.resolveLaunchAttempt(value);
					return attempt
						? { kind: "resolved" as const, value: attempt }
						: { kind: "skipped" as const };
				},
				preparationChecks(attempt) {
					return bindChecks(attempt.preparationChecks, attempt.launchConfig);
				},
				async prepare(attempt) {
					const prepared = await services.launchPlans.prepare(
						withWatcherHandoffDedupKey(attempt.launchPlan, admissionKey),
						{ modelConfig: watcher.launchModelConfig, invalidModelConfig: "omit" },
					);
					return prepared.ok
						? { ok: true as const, value: prepared.launchPlan }
						: {
								ok: false as const,
								failure: failure(
									"The launch model configuration is unavailable. Review the watcher configuration.",
									prepared,
								),
							};
				},
				async commit(launchPlan, ctx) {
					const created = await services.processLaunches.createProcessFromLaunchPlan(launchPlan, {
						actor: request.actor,
						launchRunId: ctx.launchRunId,
					});
					if (!created.ok && created.stage === "pre_commit") {
						return {
							kind: "failed" as const,
							failure: failure("The process could not be created. Try again later.", created),
						};
					}
					return created.ok
						? {
								kind: "committed" as const,
								result: created,
								process: created.process,
								startTurnId: launchPlan.startTurnId,
								reused: created.reused,
							}
						: {
								kind: "committed_with_reaction_error" as const,
								result: created,
								process: created.process,
								startTurnId: launchPlan.startTurnId,
								safeSummary:
									"Process was created, but startup failed. Review the process error and retry startup.",
							};
				},
			});
			if (result.kind === "skipped")
				return { launchRunId: opened.launchRunId, process: null, error: null };
			if (result.kind === "failed") {
				return {
					launchRunId: opened.launchRunId,
					process: null,
					error: result.failure.safeSummary,
				};
			}
			if (result.kind === "committed" && result.reused) {
				const hasTurn = deps.turnRecords.listByInstance(result.process.id).length > 0;
				const lease = deps.leases.getByInstance(result.process.id);
				if (hasTurn) mutate(opened.launchRunId, (run) => finishLaunchRun(run, "cancelled"));
				else if (!lease || ["failed", "cleanup", "exited", "absent"].includes(lease.state)) {
					mutate(opened.launchRunId, (run) =>
						failLaunchRun(
							run,
							"start_worker",
							"The existing process has not started a worker. Retry startup from the process page.",
						),
					);
				}
			}
			return {
				launchRunId: opened.launchRunId,
				process: result.process,
				error: result.kind === "committed_with_reaction_error" ? "Process startup failed." : null,
			};
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
			mutateCurrent(instanceId, null, (run) => failLaunchRun(run, "start_worker", safeSummary));
		},

		observeRunnerPhase(instanceId, workerId, phase) {
			mutateCurrent(instanceId, workerId, (run) => projectRunnerPhase(run, phase));
		},

		observeBootstrapProgress(instanceId, workerId, phase) {
			mutateCurrent(instanceId, workerId, (run) => projectBootstrapProgress(run, phase));
		},

		observeWorkerReady(instanceId, workerId) {
			mutateCurrent(instanceId, workerId, projectWorkerReady);
		},

		observeFirstTurnStarted(instanceId, workerId) {
			mutateCurrent(instanceId, workerId, projectFirstTurnStarted);
		},

		observeWorkerFailure(instanceId, workerId, safeSummary) {
			mutateCurrent(instanceId, workerId, (run) => projectWorkerFailure(run, safeSummary));
		},

		observeTitle(instanceId, status, safeSummary, launchRunId) {
			if (launchRunId) {
				const run = deps.launchRuns.getById(launchRunId);
				if (run?.instanceId === instanceId) {
					mutate(launchRunId, (current) => projectTitle(current, status, safeSummary));
				}
				return;
			}
			mutateCurrent(instanceId, null, (run) => projectTitle(run, status, safeSummary), true);
		},

		async reconcileIncomplete() {
			const incomplete = deps.launchRuns.listIncomplete();
			const authoritativeByInstance = new Map<string, LaunchRun>();
			for (const run of incomplete) {
				if (!run.instanceId) continue;
				const current = authoritativeByInstance.get(run.instanceId);
				if (!current || startupEvidenceScore(run) > startupEvidenceScore(current)) {
					authoritativeByInstance.set(run.instanceId, run);
				}
			}
			for (const run of incomplete) {
				if (run.instanceId && authoritativeByInstance.get(run.instanceId)?.id !== run.id) {
					mutate(run.id, cancelLaunchRun);
					continue;
				}
				if (!run.instanceId) {
					const replay = deps.launchRuns.getReplay<StartLaunchRequest>(run.id);
					if (["ui", "programmatic"].includes(run.origin) && replay) {
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
					mutate(run.id, cancelLaunchRun);
					continue;
				}
				const lease = deps.leases.getByInstance(run.instanceId);
				const hasTurn = deps.turnRecords.listByInstance(run.instanceId).length > 0;
				const titleJob = [...deps.titleJobs.listByProcessInstance(run.instanceId)]
					.reverse()
					.find((job) => job.launchRunId === run.id || job.launchRunId === null);
				mutate(run.id, (current) =>
					reconcileCommittedLaunch(current, {
						process,
						leaseState: lease?.state,
						hasBootstrapReceipt: Boolean(lease?.bootstrapReceipt),
						hasTurn,
						titleGenerationAvailable: Boolean(deps.titleGenerationAvailable),
						titleJobFailed: titleJob?.status === "failed",
					}),
				);
			}
		},
	};
}
