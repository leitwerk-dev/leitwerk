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
	type LaunchPipeline,
	type LaunchPipelineRunResult,
	type LaunchStageFailure,
} from "./launch-pipeline.js";
import type {
	ProcessLaunchExecutorLike,
	ProcessLaunchOptions,
	ProcessLaunchRelationInput,
} from "./process-launch-executor.js";
import { toLaunchPipelineCommit } from "./process-launch-pipeline-adapter.js";
import { buildStartupEvidence, projectLaunchRunStartup } from "./startup-evidence.js";

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

export interface PreparedPlanLaunchRequest {
	launchPlan: ProcessLaunchPlan;
	idempotencyKey: string;
	actor: Actor;
	origin: LaunchRun["origin"];
	relation?: ProcessLaunchRelationInput;
}

export interface LaunchCoordinator {
	start(request: StartLaunchRequest): Promise<{ launchRunId: string }>;
	startPreparedPlan(request: PreparedPlanLaunchRequest): Promise<{
		launchRunId: string;
		process: ProcessInstance | null;
		error: string | null;
	}>;
	startProgrammatic(
		request: ProgrammaticLaunchRequestLike,
		opts: { idempotencyKey: string; actor: Actor },
	): Promise<ProgrammaticLaunchResultLike>;
	startWatcher<TConfig, TEvent>(
		watcher: RegisteredProcessWatcherLike<TConfig, TEvent>,
		event: TEvent,
		request: { idempotencyKey: string; actor: Actor },
	): Promise<{ launchRunId: string; process: ProcessInstance | null; error: string | null }>;
	retryStartup(instanceId: string, actor: Actor): Promise<{ launchRunId: string }>;
	get(launchRunId: string): LaunchRun | null;
	refresh(instanceId: string): LaunchRun | null;
	reconcileIncomplete(): Promise<void>;
}

interface LaunchCoordinatorDeps {
	launchRuns: RepositoryBundle["launchRuns"];
	processes: RepositoryBundle["processes"];
	leases: RepositoryBundle["leases"];
	turnRecords: RepositoryBundle["turnRecords"];
	turnStarts: RepositoryBundle["turnStarts"];
	titleJobs: RepositoryBundle["titleJobs"];
	launcherService: ProcessLauncherService;
	futureExecutionLifecycle: FutureExecutionLifecycle;
	launchPipeline: LaunchPipeline;
	launchPlans: ProcessLaunchPlanServiceLike;
	processLaunches: ProcessLaunchExecutorLike;
	titleGenerationAvailable?: boolean;
	logger?: { info(message: string): void; warn(message: string): void };
}

export function createLaunchCoordinator(deps: LaunchCoordinatorDeps): LaunchCoordinator {
	const mutate = deps.launchPipeline.update;

	function activeRuns(instanceId: string): LaunchRun[] {
		return deps.launchRuns
			.listByInstance(instanceId)
			.filter(
				(run) =>
					["preparing", "process_created", "starting"].includes(run.status) ||
					run.steps.some((step) => step.id === "choose_title" && step.status === "in_progress"),
			);
	}

	/** Retries are authoritative; otherwise durable creation identity breaks ties deterministically. */
	function selectAuthoritativeRun(runs: readonly LaunchRun[]): LaunchRun | null {
		const retries = runs.filter((run) => run.origin === "startup_retry");
		return (
			[...(retries.length > 0 ? retries : runs)].sort(
				(left, right) =>
					right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
			)[0] ?? null
		);
	}

	function titleState(run: LaunchRun, process: ProcessInstance) {
		if (process.title) return { status: "completed" as const };
		if (!deps.titleGenerationAvailable) return { status: "skipped" as const };
		const job = [...deps.titleJobs.listByProcessInstance(process.id)]
			.reverse()
			.find((candidate) => candidate.launchRunId === run.id || candidate.launchRunId === null);
		if (job?.status === "failed") {
			return {
				status: "failed" as const,
				safeSummary:
					"Process started, but a title could not be generated. You can rename it later.",
			};
		}
		if (job?.status === "completed") return { status: "completed" as const };
		if (job?.status === "pending" || job?.status === "running")
			return { status: "pending" as const };
		return { status: "skipped" as const };
	}

	function project(run: LaunchRun): LaunchRun {
		if (!run.instanceId) return run;
		const process = deps.processes.getById(run.instanceId);
		if (!process) return run;
		return projectLaunchRunStartup(
			run,
			buildStartupEvidence({
				process,
				turnStarts: deps.turnStarts.listByInstance(process.id),
				leases: deps.leases.listByInstance(process.id),
				turnRecords: deps.turnRecords.listByInstance(process.id),
			}),
			titleState(run, process),
		);
	}

	function persistProjection(run: LaunchRun): LaunchRun {
		const projected = project(run);
		return JSON.stringify(projected) === JSON.stringify(run)
			? run
			: mutate(run.id, () => projected);
	}

	function failure<T>(safeSummary: string, value: T): LaunchStageFailure<T> {
		return { safeSummary, value };
	}

	function existingLaunchResult(run: LaunchRun) {
		return {
			launchRunId: run.id,
			process: run.instanceId ? deps.processes.getById(run.instanceId) : null,
			error:
				run.status === "failed"
					? "The previous launch attempt failed."
					: run.instanceId
						? null
						: "The launch is still in progress.",
		};
	}

	function presentPipelineResult<TResult, TFailure>(
		launchRunId: string,
		result: LaunchPipelineRunResult<TResult, TFailure>,
		skippedError: string | null,
	) {
		if (result.kind === "failed") {
			return { launchRunId, process: null, error: result.failure.safeSummary };
		}
		if (result.kind === "skipped") return { launchRunId, process: null, error: skippedError };
		return {
			launchRunId,
			process: result.process,
			error:
				result.kind === "committed_with_reaction_error"
					? "Process was created, but the worker could not be started cleanly. Review the process error and retry startup."
					: null,
		};
	}

	function presentProgrammaticResult(
		launchRunId: string,
		result: LaunchMutationOutcome,
	): ProgrammaticLaunchResultLike {
		if (result.kind === "launched" || result.kind === "committed_with_reaction_error") {
			return {
				launchRunId,
				process: "process" in result ? result.process : null,
				error: result.kind === "committed_with_reaction_error" ? result.error : null,
			};
		}
		return {
			launchRunId,
			process: null,
			error:
				result.kind === "invalid"
					? (result.issues[0]?.message ?? "Launch input is invalid")
					: "issue" in result
						? result.issue.message
						: "The launch could not be completed",
		};
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

	async function commitLaunchPlan(
		executor: ProcessLaunchExecutorLike,
		launchPlan: ProcessLaunchPlan,
		launchRunId: string,
		opts: ProcessLaunchOptions,
	) {
		const created = await executor.createProcessFromLaunchPlan(launchPlan, {
			...opts,
			launchRunId,
		});
		return toLaunchPipelineCommit(created, {
			startTurnId: launchPlan.startTurnId,
			preCommitSummary: "The process could not be created. Try again later.",
			postCommitSummary:
				"Process was created, but the worker could not be started cleanly. Review the process error and retry startup.",
			mapPreCommitFailure: (failed) => failed,
		});
	}

	async function execute(runId: string, input: StartLaunchRequest): Promise<LaunchMutationOutcome> {
		try {
			const pipelineResult = await deps.launchPipeline.run<
				ResolvedProcessLauncher,
				PreparedLaunch,
				LaunchMutationOutcome,
				unknown
			>(runId, {
				async resolve() {
					const request = input;
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
			persistProjection(deps.launchRuns.getById(runId) as LaunchRun);
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

		async startPreparedPlan(request) {
			const idempotencyKey = request.idempotencyKey.trim();
			if (!idempotencyKey) throw new Error("Launch idempotency key is required");
			const opened = deps.launchPipeline.open({
				launcherId: request.launchPlan.launcherId,
				idempotencyKey,
				origin: request.origin,
			});
			if (opened.existing) {
				const existing = deps.launchRuns.getById(opened.launchRunId);
				if (!existing) throw new Error(`Launch run '${opened.launchRunId}' does not exist`);
				return existingLaunchResult(existing);
			}
			type PreparedPlanResult = Awaited<
				ReturnType<ProcessLaunchExecutorLike["createProcessFromLaunchPlan"]>
			>;
			const result = await deps.launchPipeline.run<
				ProcessLaunchPlan,
				ProcessLaunchPlan,
				PreparedPlanResult,
				unknown
			>(opened.launchRunId, {
				async resolve() {
					return { kind: "resolved", value: request.launchPlan };
				},
				async prepare(launchPlan) {
					return { ok: true, value: launchPlan };
				},
				commit: (launchPlan, ctx) =>
					commitLaunchPlan(deps.processLaunches, launchPlan, ctx.launchRunId, {
						actor: request.actor,
						...(request.relation ? { relation: request.relation } : {}),
					}),
			});
			if (result.kind !== "failed" && result.kind !== "skipped") {
				const projected = deps.launchRuns.getById(opened.launchRunId);
				if (projected) persistProjection(projected);
			}
			return presentPipelineResult(opened.launchRunId, result, "Launch skipped.");
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
			return presentProgrammaticResult(
				opened.launchRunId,
				await execute(opened.launchRunId, input),
			);
		},

		async startWatcher(watcher, event, request) {
			const admissionKey = watcherAdmissionKey(request.idempotencyKey);
			const existing = deps.launchRuns.getByIdempotencyKey(admissionKey);
			if (existing && (existing.instanceId || !["failed", "cancelled"].includes(existing.status))) {
				const presented = existingLaunchResult(existing);
				return { ...presented, error: existing.status === "failed" ? presented.error : null };
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
				WatcherAttempt,
				ProcessLaunchPlan,
				WatcherResult,
				unknown
			>(opened.launchRunId, {
				async resolve() {
					const attempt = await watcher.resolveLaunchAttempt(event);
					return attempt
						? { kind: "resolved" as const, value: attempt }
						: { kind: "skipped" as const };
				},
				preparationChecks(attempt) {
					return bindChecks(attempt.preparationChecks, attempt.launchConfig);
				},
				async prepare(attempt) {
					const prepared = await deps.launchPlans.prepare(
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
				commit: (launchPlan, ctx) =>
					commitLaunchPlan(deps.processLaunches, launchPlan, ctx.launchRunId, {
						actor: request.actor,
					}),
			});
			if (result.kind === "skipped" || result.kind === "failed")
				return presentPipelineResult(opened.launchRunId, result, null);
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
			const projected = deps.launchRuns.getById(opened.launchRunId);
			if (projected) persistProjection(projected);
			return presentPipelineResult(opened.launchRunId, result, null);
		},

		async retryStartup(instanceId) {
			if (!deps.processes.getById(instanceId)) throw new Error("Process not found");
			const opened = deps.launchPipeline.open({
				launcherId: null,
				origin: "startup_retry",
				broadcast: false,
			});
			mutate(opened.launchRunId, (run) => ({
				...run,
				instanceId,
				status: "starting",
				steps: run.steps.map((item) =>
					["validate_request", "resolve_models_skills", "create_process", "choose_title"].includes(
						item.id,
					)
						? { ...item, status: "skipped" as const }
						: item,
				),
			}));
			return { launchRunId: opened.launchRunId };
		},

		get(launchRunId) {
			const run = deps.launchRuns.getById(launchRunId);
			return run ? persistProjection(run) : null;
		},

		refresh(instanceId) {
			const run = selectAuthoritativeRun(activeRuns(instanceId));
			return run ? persistProjection(run) : null;
		},

		async reconcileIncomplete() {
			const incomplete = deps.launchRuns.listIncomplete();
			const byInstance = new Map<string, LaunchRun[]>();
			for (const run of incomplete) {
				if (!run.instanceId) continue;
				const runs = byInstance.get(run.instanceId) ?? [];
				runs.push(run);
				byInstance.set(run.instanceId, runs);
			}
			for (const runs of byInstance.values()) {
				const authoritative = selectAuthoritativeRun(runs);
				for (const run of runs) {
					if (run.id !== authoritative?.id)
						mutate(run.id, (current) => finishLaunchRun(current, "cancelled"));
				}
			}
			for (const run of incomplete) {
				if (
					run.instanceId &&
					selectAuthoritativeRun(byInstance.get(run.instanceId) ?? [])?.id !== run.id
				)
					continue;
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
				if (!deps.processes.getById(run.instanceId)) {
					mutate(run.id, (current) => finishLaunchRun(current, "cancelled"));
					continue;
				}
				persistProjection(run);
			}
		},
	};
}
