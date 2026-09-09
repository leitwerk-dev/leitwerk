import {
	type Actor,
	type FutureExecution,
	normalizeLaunchModelConfigInput,
	type ProcessInstance,
	type ProcessProject,
	SYSTEM_ACTOR,
} from "@leitwerk-dev/domain";
import type {
	ProcessLauncherService,
	ProcessLaunchPlan,
	ProcessLaunchPlanServiceLike,
	ResolvedProcessLauncher,
} from "@leitwerk-dev/process-sdk";
import {
	type FutureLaunchPayload,
	type LauncherModelConfigDefaults,
	type ParsedScheduleRequest,
	parseFutureLaunchPayloadJson,
	type SkillSelection,
	serializeFutureLaunchPayload,
	validateScheduleRequestInput,
} from "@leitwerk-dev/protocol";
import type { RepositoryBundle } from "../db/repositories.js";
import { nextCronOccurrenceUtc } from "../domain-logic/cron.js";
import type { ExtensionHost } from "../extensions/extension-host.js";
import type { LaunchPipeline } from "../launch-pipeline.js";
import {
	applySubmittedProcessTitleToLaunchPlan,
	normalizeProcessTitleInput,
} from "../launch-title.js";
import type { LauncherRecentValuesService } from "../launcher-recent-values-service.js";
import type { ModelStatusCache } from "../model-providers/model-status-cache.js";
import type { ProcessEngineLogger } from "../process-engine/types.js";
import {
	createProcessFromLaunchPlan,
	createScheduledProcessFromLaunchPlan,
} from "../process-launch-executor.js";
import {
	bindLaunchPreparationChecks,
	toLaunchPipelineCommit,
} from "../process-launch-pipeline-adapter.js";
import {
	applyStoredLaunchPlanModelConfig,
	clearLaunchPlanModelConfig,
} from "../process-launch-plan-model-config.js";
import type { ServerProcessModelPolicy } from "../process-model-policy/index.js";
import { presentLaunchPlanPreparationIssues } from "../process-model-policy-presenter.js";
import type { ProcessOperationCoordinator } from "../process-operation-coordinator.js";
import type { ProcessTitleGenerator } from "../process-title-generator.js";
import type { Broadcaster } from "../ws/broadcast.js";
import { projectLaunchPlanModelState } from "./model-projection.js";
import {
	buildFutureExecutionUpdatedEffect,
	buildQueueFutureExecutionTitleEffect,
	resolveStoredScheduleRequest,
	runFutureExecutionExclusive,
	runFutureExecutionPostCommitEffects,
} from "./support.js";
import { planConsumeFutureExecution } from "./transition-planner.js";

export interface FutureExecutionIssue {
	code: string;
	message: string;
	fieldId?: string;
}

type LaunchFailure =
	| { kind: "invalid"; issues: readonly FutureExecutionIssue[] }
	| { kind: "not_found"; target: "future_execution" | "launch" | "action" | "process" }
	| { kind: "conflict"; issue: FutureExecutionIssue }
	| { kind: "unavailable"; reason: string }
	| { kind: "failed"; issue: FutureExecutionIssue };

export type LaunchMutationOutcome =
	| { kind: "scheduled"; execution: FutureExecution; operation: "created" | "updated" }
	| {
			kind: "launched";
			process: ProcessInstance;
			projects: ProcessProject[];
			operation: "created" | "updated";
	  }
	| {
			kind: "committed_with_reaction_error";
			process: ProcessInstance;
			projects: ProcessProject[];
			error: string;
			code?: string;
	  }
	| {
			kind: "committed_with_reaction_error";
			execution: FutureExecution;
			operation: "created" | "updated";
			error: string;
			code: string;
	  }
	| LaunchFailure;

export interface NormalizedScheduledLaunchInput {
	title: string | null;
	titleProvided: boolean;
	launcherInput: Record<string, unknown>;
	launcherInputProvided: boolean;
	skillIds?: string[];
	modelConfig: LauncherModelConfigDefaults;
	modelConfigProvided: boolean;
	schedule: ParsedScheduleRequest;
	scheduleProvided: boolean;
}

export type ValidatedLaunchSchedule =
	| { mode: "now"; nextRunAt: null; cronExpression: null }
	| { mode: "once"; nextRunAt: string; cronExpression: null }
	| { mode: "cron"; nextRunAt: string; cronExpression: string };

export interface PreparedLaunch {
	processId: string;
	launcherId: string;
	launcherInput: Record<string, unknown>;
	modelConfig: LauncherModelConfigDefaults;
	launchPlan: ProcessLaunchPlan;
	selectedSkillIds: readonly string[];
	resourceSelections: readonly SkillSelection[];
	modelState: ReturnType<typeof projectLaunchPlanModelState>;
	schedule: ValidatedLaunchSchedule;
}

export type PreparedLaunchResult =
	| { ok: true; prepared: PreparedLaunch }
	| { ok: false; outcome: LaunchMutationOutcome };

export interface FutureLaunchLifecycleDeps
	extends Pick<
		RepositoryBundle,
		| "futureExecutions"
		| "processes"
		| "projects"
		| "processRelations"
		| "skills"
		| "processSkills"
		| "handoffDedupKeys"
		| "transaction"
	> {
	broadcaster: Broadcaster;
	commands: Parameters<typeof createProcessFromLaunchPlan>[0]["commands"];
	launcherService?: ProcessLauncherService;
	processOperations: ProcessOperationCoordinator;
	launcherRecentValues?: LauncherRecentValuesService;
	launchPlans: ProcessLaunchPlanServiceLike;
	launchPipeline: LaunchPipeline;
	processTitles?: ProcessTitleGenerator;
	extensionHost?: ExtensionHost;
	processModelPolicy: ServerProcessModelPolicy;
	modelStatusCache: Pick<ModelStatusCache, "snapshot">;
	logger?: ProcessEngineLogger;
}

function invalidOutcome(
	code: string,
	message: string,
): Extract<LaunchFailure, { kind: "invalid" }> {
	return { kind: "invalid", issues: [{ code, message }] };
}

function resolveSelectedSkills(
	skills: FutureLaunchLifecycleDeps["skills"],
	ids: readonly string[],
):
	| { ok: true; value: readonly SkillSelection[] }
	| { ok: false; outcome: Extract<LaunchFailure, { kind: "invalid" }> } {
	try {
		return { ok: true, value: skills.resolveActive(ids) };
	} catch (error) {
		return {
			ok: false,
			outcome: invalidOutcome(
				"invalid_skill_selection",
				error instanceof Error ? error.message : "Invalid skill selection",
			),
		};
	}
}

function launcherResolutionFailure(
	result: Extract<Awaited<ReturnType<ProcessLauncherService["resolveUiLauncher"]>>, { ok: false }>,
): Extract<LaunchFailure, { kind: "invalid" }> {
	return {
		kind: "invalid",
		issues: result.errors.map((issue) => ({
			code: issue.code,
			message: issue.message,
			...(issue.fieldId !== undefined ? { fieldId: issue.fieldId } : {}),
		})),
	};
}

function launchFailureOutcome(
	result: Exclude<Awaited<ReturnType<typeof createProcessFromLaunchPlan>>, { ok: true }>,
): LaunchMutationOutcome {
	const issue = {
		code: typeof result.body.code === "string" ? result.body.code : "process_launch_failed",
		message: typeof result.body.error === "string" ? result.body.error : "Failed to launch process",
	};
	return result.stage === "post_commit"
		? {
				kind: "committed_with_reaction_error",
				process: result.process,
				projects: result.projects,
				error: issue.message,
				code: issue.code,
			}
		: { kind: "failed", issue };
}

function resolveScheduledLaunchUpdateRequest(
	execution: FutureExecution,
	request: NormalizedScheduledLaunchInput,
	existingPayload: FutureLaunchPayload,
) {
	const schedule = request.scheduleProvided
		? ({ ok: true, value: request.schedule } as const)
		: resolveStoredScheduleRequest(execution);
	if (!schedule.ok) return schedule;
	return {
		ok: true as const,
		value: {
			title: request.titleProvided ? request.title : existingPayload.launchPlan.processInput.title,
			titleProvided: true,
			launcherInput: request.launcherInputProvided
				? request.launcherInput
				: existingPayload.launcherInput,
			launcherInputProvided: true,
			skillIds: request.skillIds ?? existingPayload.selectedSkillIds,
			modelConfig: request.modelConfigProvided ? request.modelConfig : existingPayload.modelConfig,
			modelConfigProvided: request.modelConfigProvided,
			schedule: schedule.value,
			scheduleProvided: true,
			actor: existingPayload.actor,
		},
	};
}

export function createFutureLaunchLifecycle(
	deps: FutureLaunchLifecycleDeps,
	options: { now?: () => Date } = {},
) {
	const now = options.now ?? (() => new Date());

	function recordLauncherRecentsBestEffort(
		launcherId: string,
		launcherInput: Record<string, unknown>,
	): void {
		try {
			deps.launcherRecentValues?.record(launcherId, launcherInput);
		} catch (error) {
			deps.logger?.error?.(
				{ err: error instanceof Error ? error.message : String(error), launcherId },
				"Failed to record launcher recent values",
			);
		}
	}

	async function prepareResolvedLaunch(input: {
		baseLaunchPlan: ProcessLaunchPlan;
		modelConfig: LauncherModelConfigDefaults;
		title: string | null;
		titleProvided: boolean;
		schedule: ParsedScheduleRequest;
		operationTime?: Date;
	}) {
		const operationTime = input.operationTime ?? now();
		const schedule = validateScheduleRequestInput(input.schedule, ["now", "once", "cron"], {
			resolveCronNextRunAt: (expression) => nextCronOccurrenceUtc(expression, operationTime),
		});
		if (!schedule.ok)
			return { ok: false as const, outcome: invalidOutcome("invalid_schedule", schedule.error) };
		const prepared = await deps.launchPlans.prepare(input.baseLaunchPlan, {
			modelConfig: normalizeLaunchModelConfigInput(input.modelConfig),
			invalidModelConfig: "reject",
		});
		if (!prepared.ok && schedule.value.mode === "now") {
			return {
				ok: false as const,
				outcome: {
					kind: "invalid" as const,
					issues: presentLaunchPlanPreparationIssues(prepared.errors),
				},
			};
		}
		const launchPlan = applySubmittedProcessTitleToLaunchPlan(prepared.launchPlan, input);
		const modelState = projectLaunchPlanModelState(launchPlan, {
			policy: deps.processModelPolicy,
			availability: deps.modelStatusCache.snapshot(),
			detectedAt: operationTime.toISOString(),
		});
		if (!prepared.ok && !modelState.blockedReason) {
			return {
				ok: false as const,
				outcome: {
					kind: "invalid" as const,
					issues: presentLaunchPlanPreparationIssues(prepared.errors),
				},
			};
		}
		return { ok: true as const, launchPlan, modelState, schedule: schedule.value };
	}

	async function persistPreparedLaunch(
		input: PreparedLaunch & { existing?: FutureExecution; actor: Actor },
	): Promise<LaunchMutationOutcome> {
		if (input.schedule.mode === "now") throw new Error("Immediate launches cannot be persisted");
		const values = {
			scheduleKind: input.schedule.mode,
			processId: input.processId,
			launcherId: input.launcherId,
			payloadJson: serializeFutureLaunchPayload({
				launcherInput: input.launcherInput,
				modelConfig: input.modelConfig,
				actor: input.actor,
				selectedSkillIds: input.selectedSkillIds,
				resourceSelections: input.resourceSelections,
				launchPlan: input.launchPlan,
			}),
			cronExpression: input.schedule.cronExpression,
			nextRunAt: input.schedule.nextRunAt,
			...input.modelState,
		};
		const execution = input.existing
			? deps.futureExecutions.update(input.existing.id, values)
			: deps.futureExecutions.create({ kind: "launch", ...values });
		if (!execution) return { kind: "not_found", target: "launch" };
		const operation = input.existing ? "updated" : "created";
		const reaction = await runFutureExecutionPostCommitEffects(deps, [
			buildFutureExecutionUpdatedEffect(execution, operation),
			buildQueueFutureExecutionTitleEffect(execution, input.launchPlan),
		]);
		recordLauncherRecentsBestEffort(input.launcherId, input.launcherInput);
		return reaction.ok
			? { kind: "scheduled", execution, operation }
			: {
					kind: "committed_with_reaction_error",
					execution,
					operation,
					error: reaction.message,
					code: reaction.code,
				};
	}

	async function prepareLaunchInternal(input: {
		launcherId: string;
		request: NormalizedScheduledLaunchInput;
		baseLaunchPlan?: ProcessLaunchPlan;
		resourceSelections?: readonly SkillSelection[];
		operationTime?: Date;
		resolvedLauncher?: ResolvedProcessLauncher;
	}): Promise<PreparedLaunchResult> {
		if (!deps.launcherService)
			return {
				ok: false,
				outcome: { kind: "unavailable", reason: "Launcher service is not available" },
			};
		const resolved = input.resolvedLauncher
			? { ok: true as const, launcher: input.resolvedLauncher }
			: await deps.launcherService.resolveUiLauncher(input.launcherId, input.request.launcherInput);
		if (!resolved.ok) return { ok: false, outcome: launcherResolutionFailure(resolved) };
		const resourceSelections = input.resourceSelections
			? { ok: true as const, value: input.resourceSelections }
			: resolveSelectedSkills(deps.skills, input.request.skillIds ?? []);
		if (!resourceSelections.ok) return { ok: false, outcome: resourceSelections.outcome };

		// A revised launch uses its persisted plan as the source of stored model
		// defaults, while an explicit request always wins over those defaults.
		const baseLaunchPlan = input.request.modelConfigProvided
			? clearLaunchPlanModelConfig(resolved.launcher.launchPlan)
			: input.baseLaunchPlan
				? applyStoredLaunchPlanModelConfig(
						resolved.launcher.launchPlan,
						input.baseLaunchPlan.processInput,
					)
				: resolved.launcher.launchPlan;
		const result = await prepareResolvedLaunch({
			baseLaunchPlan,
			modelConfig: input.request.modelConfig,
			title: input.request.title,
			titleProvided: input.request.titleProvided,
			schedule: input.request.schedule,
			operationTime: input.operationTime,
		});
		if (!result.ok) return { ok: false, outcome: result.outcome };
		return {
			ok: true,
			prepared: {
				processId: resolved.launcher.processId,
				launcherId: resolved.launcher.launcherId,
				launcherInput: input.request.launcherInput,
				modelConfig: input.request.modelConfig,
				launchPlan: result.launchPlan,
				selectedSkillIds: input.request.skillIds ?? [],
				resourceSelections: resourceSelections.value,
				modelState: result.modelState,
				schedule: result.schedule,
			},
		};
	}

	async function launchScheduledNow(
		existing: FutureExecution,
		request: NormalizedScheduledLaunchInput,
		operationTime: Date,
		actor?: Actor,
	): Promise<LaunchMutationOutcome> {
		const opened = deps.launchPipeline.open({ launcherId: existing.launcherId, origin: "ui" });
		type ResolvedRevision = {
			payload: FutureLaunchPayload;
			request: NormalizedScheduledLaunchInput;
			launcher: ResolvedProcessLauncher;
			actor: Actor;
		};
		const result = await deps.launchPipeline.run<
			ResolvedRevision,
			PreparedLaunch & { actor: Actor },
			LaunchMutationOutcome,
			LaunchMutationOutcome
		>(opened.launchRunId, {
			async resolve() {
				const failure = (value: LaunchMutationOutcome) => ({
					kind: "failed" as const,
					failure: { safeSummary: "Review the launch configuration and try again.", value },
				});
				if (!deps.launcherService)
					return failure({ kind: "unavailable", reason: "Launcher service is not available" });
				const parsed = parseFutureLaunchPayloadJson(existing.payloadJson);
				if (!parsed.ok)
					return failure(invalidOutcome("invalid_payload", "Scheduled launch payload is invalid"));
				const launchRequest = resolveScheduledLaunchUpdateRequest(existing, request, parsed.value);
				if (!launchRequest.ok) return failure({ kind: "invalid", issues: [launchRequest.issue] });
				const resolved = await deps.launcherService.resolveUiLauncher(
					existing.launcherId ?? parsed.value.launchPlan.launcherId,
					launchRequest.value.launcherInput,
				);
				if (!resolved.ok) return failure(launcherResolutionFailure(resolved));
				return {
					kind: "resolved",
					value: {
						payload: parsed.value,
						request: launchRequest.value,
						launcher: resolved.launcher,
						actor: actor ?? launchRequest.value.actor ?? SYSTEM_ACTOR,
					},
				};
			},
			preparationChecks(resolved) {
				const checks =
					deps.launcherService?.resolvePreparationChecks?.(
						resolved.launcher.launcherId,
						resolved.request.launcherInput,
						resolved.launcher.launchConfig,
					) ?? [];
				return bindLaunchPreparationChecks(checks, resolved.launcher.launchConfig);
			},
			preparationCheckFailure() {
				return invalidOutcome("preparation_failed", "Launch preparation failed");
			},
			async prepare(resolved) {
				const prepared = await prepareLaunchInternal({
					launcherId: resolved.launcher.launcherId,
					request: resolved.request,
					baseLaunchPlan: resolved.payload.launchPlan,
					resourceSelections: request.skillIds ? undefined : resolved.payload.resourceSelections,
					operationTime,
					resolvedLauncher: resolved.launcher,
				});
				return prepared.ok
					? { ok: true, value: { ...prepared.prepared, actor: resolved.actor } }
					: {
							ok: false,
							failure: {
								safeSummary: "Review the launch configuration and try again.",
								value: prepared.outcome,
							},
						};
			},
			async commit(prepared, ctx) {
				const created = await createScheduledProcessFromLaunchPlan(
					deps,
					prepared.launchPlan,
					planConsumeFutureExecution(existing),
					{
						actor: prepared.actor,
						resourceSelections: prepared.resourceSelections,
						launchIntent: { launcherInput: prepared.launcherInput },
						launchRunId: ctx.launchRunId,
					},
				);
				const committed = toLaunchPipelineCommit<LaunchMutationOutcome, LaunchMutationOutcome>(
					created,
					{
						startTurnId: prepared.launchPlan.startTurnId,
						preCommitSummary: "The process could not be created. Try again later.",
						postCommitSummary:
							"Process was created, but the worker could not be started cleanly. Review the process error and retry startup.",
						mapPreCommitFailure: launchFailureOutcome,
						mapCommittedResult: (outcome) =>
							outcome.ok
								? {
										kind: "launched",
										process: outcome.process,
										projects: outcome.projects,
										operation: "updated",
									}
								: launchFailureOutcome(outcome),
					},
				);
				if (committed.kind === "failed") return committed;
				const reaction = await runFutureExecutionPostCommitEffects(deps, [
					buildFutureExecutionUpdatedEffect(existing, "deleted"),
				]);
				if (!reaction.ok && created.ok) {
					return {
						kind: "committed_with_reaction_error",
						process: committed.process,
						startTurnId: prepared.launchPlan.startTurnId,
						safeSummary: "Process was created, but the schedule update could not be published.",
						result: {
							kind: "committed_with_reaction_error",
							process: committed.process,
							projects: created.projects,
							error: reaction.message,
							code: reaction.code,
						},
					};
				}
				if (committed.kind === "committed")
					recordLauncherRecentsBestEffort(prepared.launcherId, prepared.launcherInput);
				return committed;
			},
			unexpectedFailure() {
				return {
					safeSummary: "The launch could not be completed. Try again.",
					value: {
						kind: "failed",
						issue: { code: "process_launch_failed", message: "The launch could not be completed" },
					},
				};
			},
		});
		if (result.kind === "failed") return result.failure.value;
		if (result.kind === "skipped") return { kind: "not_found", target: "launch" };
		return result.result;
	}

	return {
		async prepareLaunch(
			launcherId: string,
			request: NormalizedScheduledLaunchInput,
			opts?: { resolvedLauncher?: ResolvedProcessLauncher },
		): Promise<PreparedLaunchResult> {
			return prepareLaunchInternal({
				launcherId,
				request,
				...(opts?.resolvedLauncher ? { resolvedLauncher: opts.resolvedLauncher } : {}),
			});
		},
		async commitPreparedLaunch(
			prepared: PreparedLaunch,
			opts?: { actor?: Actor; launchRunId?: string },
		): Promise<LaunchMutationOutcome> {
			if (prepared.schedule.mode !== "now")
				return persistPreparedLaunch({ ...prepared, actor: opts?.actor ?? SYSTEM_ACTOR });
			const created = await createProcessFromLaunchPlan(deps, prepared.launchPlan, {
				...opts,
				resourceSelections: prepared.resourceSelections,
				launchIntent: { launcherInput: prepared.launcherInput },
			});
			if (!created.ok) return launchFailureOutcome(created);
			recordLauncherRecentsBestEffort(prepared.launcherId, prepared.launcherInput);
			return {
				kind: "launched",
				process: created.process,
				projects: created.projects,
				operation: "created",
			};
		},
		async applyGeneratedFutureLaunchTitleIfUnchanged(input: {
			futureExecutionId: string;
			expectedPayloadJson: string;
			title: string;
		}): Promise<
			| { kind: "applied"; execution: FutureExecution }
			| {
					kind: "applied_with_reaction_error";
					execution: FutureExecution;
					error: string;
					code: string;
			  }
			| { kind: "superseded" }
			| { kind: "failed"; error: string }
		> {
			return runFutureExecutionExclusive(
				deps.processOperations,
				input.futureExecutionId,
				async () => {
					const current = deps.futureExecutions.getById(input.futureExecutionId);
					if (
						!current ||
						current.kind !== "launch" ||
						current.payloadJson !== input.expectedPayloadJson
					) {
						return { kind: "superseded" };
					}
					const parsed = parseFutureLaunchPayloadJson(current.payloadJson);
					if (!parsed.ok) return { kind: "failed", error: parsed.error };
					if (normalizeProcessTitleInput(parsed.value.launchPlan.processInput.title)) {
						return { kind: "superseded" };
					}
					const updated = deps.futureExecutions.updatePayloadJsonIfUnchanged(
						current.id,
						current.payloadJson,
						serializeFutureLaunchPayload({
							...parsed.value,
							launchPlan: {
								...parsed.value.launchPlan,
								processInput: {
									...parsed.value.launchPlan.processInput,
									title: input.title,
								},
							},
						}),
					);
					if (!updated) return { kind: "superseded" };
					const reaction = await runFutureExecutionPostCommitEffects(deps, [
						buildFutureExecutionUpdatedEffect(updated, "updated"),
					]);
					return reaction.ok
						? { kind: "applied", execution: updated }
						: {
								kind: "applied_with_reaction_error",
								execution: updated,
								error: reaction.message,
								code: reaction.code,
							};
				},
			);
		},
		async reviseScheduledLaunch(
			futureExecutionId: string,
			request: NormalizedScheduledLaunchInput,
			opts?: { actor?: Actor },
		): Promise<LaunchMutationOutcome> {
			const operationTime = now();
			return runFutureExecutionExclusive(deps.processOperations, futureExecutionId, async () => {
				const existing = deps.futureExecutions.getById(futureExecutionId);
				if (!existing || existing.kind !== "launch") return { kind: "not_found", target: "launch" };
				if (request.scheduleProvided && request.schedule.mode === "now")
					return launchScheduledNow(existing, request, operationTime, opts?.actor);
				const parsed = parseFutureLaunchPayloadJson(existing.payloadJson);
				if (!parsed.ok)
					return invalidOutcome("invalid_payload", "Scheduled launch payload is invalid");
				const launchRequest = resolveScheduledLaunchUpdateRequest(existing, request, parsed.value);
				if (!launchRequest.ok) return { kind: "invalid", issues: [launchRequest.issue] };
				const prepared = await prepareLaunchInternal({
					launcherId: existing.launcherId ?? parsed.value.launchPlan.launcherId,
					request: launchRequest.value,
					baseLaunchPlan: parsed.value.launchPlan,
					resourceSelections: request.skillIds ? undefined : parsed.value.resourceSelections,
					operationTime,
				});
				if (!prepared.ok) return prepared.outcome;
				return persistPreparedLaunch({
					...prepared.prepared,
					existing,
					actor: opts?.actor ?? launchRequest.value.actor ?? SYSTEM_ACTOR,
				});
			});
		},
	};
}
