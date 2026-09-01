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
	type FutureActionPayload,
	type FutureLaunchPayload,
	type LauncherModelConfigDefaults,
	type ParsedScheduleRequest,
	parseFutureActionPayloadJson,
	parseFutureLaunchPayloadJson,
	type SkillSelection,
	serializeFutureActionPayload,
	serializeFutureLaunchPayload,
	validateScheduleRequestInput,
} from "@leitwerk-dev/protocol";
import type { RepositoryBundle } from "../db/repositories.js";
import { nextCronOccurrenceUtc } from "../domain-logic/cron.js";
import type { ExtensionHost } from "../extensions/extension-host.js";
import type { LaunchCoordinator } from "../launch-coordinator.js";
import {
	applySubmittedProcessTitleToLaunchPlan,
	normalizeProcessTitleInput,
} from "../launch-title.js";
import type { LauncherRecentValuesService } from "../launcher-recent-values-service.js";
import type {
	ModelStatusCache,
	ModelStatusCacheSnapshot,
} from "../model-providers/model-status-cache.js";
import type { ProcessActionRegistry } from "../process-action-registry.js";
import { isInternalEngineFailureCode } from "../process-engine/internal-failures.js";
import type { ProcessEngine, ProcessEngineLogger } from "../process-engine/types.js";
import type { ProcessGraphRegistry } from "../process-graph.js";
import {
	createProcessFromLaunchPlan,
	createScheduledProcessFromLaunchPlan,
} from "../process-launch-executor.js";
import {
	applyStoredLaunchPlanModelConfig,
	clearLaunchPlanModelConfig,
} from "../process-launch-plan-model-config.js";
import type { ServerProcessModelPolicy } from "../process-model-policy/index.js";
import {
	presentLaunchPlanPreparationIssues,
	presentProcessModelPolicyFailure,
} from "../process-model-policy-presenter.js";
import type { ProcessOperationCoordinator } from "../process-operation-coordinator.js";
import type { ProcessTitleGenerator } from "../process-title-generator.js";
import { preflightScheduledActionRequest } from "../scheduled-action-preflight.js";
import type { Broadcaster } from "../ws/broadcast.js";
import { createFutureExecutionExecutor, type FutureExecutionItemOutcome } from "./execution.js";
import { evaluateFutureModelSelection, projectLaunchPlanModelState } from "./model-projection.js";
import { reconcileFutureExecutionModelBlocks } from "./reconciliation.js";
import {
	buildFutureExecutionUpdatedEffect,
	buildQueueFutureExecutionTitleEffect,
	runFutureExecutionExclusive,
	runFutureExecutionPostCommitEffects,
} from "./support.js";
import { planConsumeFutureExecution } from "./transition-planner.js";

export interface FutureExecutionLifecycleDeps
	extends Pick<
		RepositoryBundle,
		| "futureExecutions"
		| "processes"
		| "projects"
		| "handoffDedupKeys"
		| "turnRecords"
		| "skills"
		| "processSkills"
		| "transaction"
	> {
	broadcaster: Broadcaster;
	commands: ProcessEngine;
	processOperations: ProcessOperationCoordinator;
	launcherService?: ProcessLauncherService;
	launcherRecentValues?: LauncherRecentValuesService;
	launchPlans: ProcessLaunchPlanServiceLike;
	processTitles?: ProcessTitleGenerator;
	extensionHost?: ExtensionHost;
	processGraphs?: ProcessGraphRegistry;
	processActionRegistry?: ProcessActionRegistry;
	processModelPolicy: ServerProcessModelPolicy;
	modelStatusCache: Pick<ModelStatusCache, "snapshot">;
	getLaunchCoordinator?: () => LaunchCoordinator | undefined;
	logger?: ProcessEngineLogger;
}

export interface FutureExecutionLifecycleOptions {
	now?: () => Date;
}

export interface FutureExecutionIssue {
	code: string;
	message: string;
	fieldId?: string;
}

type LifecycleFailure =
	| { kind: "invalid"; issues: readonly FutureExecutionIssue[] }
	| { kind: "not_found"; target: "future_execution" | "launch" | "action" | "process" }
	| { kind: "conflict"; issue: FutureExecutionIssue }
	| { kind: "unavailable"; reason: string }
	| { kind: "failed"; issue: FutureExecutionIssue };

export type LaunchMutationOutcome =
	| {
			kind: "scheduled";
			execution: FutureExecution;
			operation: "created" | "updated";
	  }
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
	| LifecycleFailure;

export type ActionMutationOutcome =
	| {
			kind: "scheduled";
			execution: FutureExecution;
			instanceId: string;
			operation: "created" | "updated";
	  }
	| {
			kind: "executed";
			process: ProcessInstance;
			data?: Record<string, unknown>;
	  }
	| {
			kind: "committed_with_reaction_error";
			process: ProcessInstance;
			error: string;
			code?: string;
	  }
	| {
			kind: "committed_with_reaction_error";
			execution: FutureExecution;
			instanceId: string;
			operation: "created" | "updated";
			error: string;
			code: string;
	  }
	| LifecycleFailure;

export type CancelFutureExecutionOutcome =
	| { kind: "canceled"; execution: FutureExecution }
	| {
			kind: "committed_with_reaction_error";
			execution: FutureExecution;
			error: string;
			code: string;
	  }
	| { kind: "not_found"; target: "future_execution" };

export interface FutureExecutionDueItemOutcome {
	futureExecutionId: string;
	kind: FutureExecutionItemOutcome["kind"] | "unexpected_error";
	error?: string;
}

export interface FutureExecutionDueBatchOutcome {
	kind: "batch_completed";
	asOf: string;
	items: FutureExecutionDueItemOutcome[];
}

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

export interface NormalizedScheduledActionInput {
	input: Record<string, unknown>;
	inputProvided: boolean;
	nextTurnModelProfileId?: string | null;
	nextTurnModelProfileIdProvided: boolean;
	schedule: ParsedScheduleRequest;
	scheduleProvided: boolean;
}

type Resolved<T> = { ok: true; value: T } | { ok: false; issue: FutureExecutionIssue };

function resolveStoredScheduleRequest(
	execution: Pick<FutureExecution, "scheduleKind" | "nextRunAt" | "cronExpression">,
): Resolved<ParsedScheduleRequest> {
	if (execution.scheduleKind === "cron") {
		if (!execution.cronExpression) {
			return {
				ok: false,
				issue: {
					code: "invalid_schedule",
					message: "Scheduled execution is missing its cron expression",
				},
			};
		}
		return {
			ok: true,
			value: { mode: "cron", cronExpression: execution.cronExpression },
		};
	}
	return {
		ok: true,
		value: { mode: "once", runAt: execution.nextRunAt },
	};
}

function resolveScheduledLaunchUpdateRequest(
	execution: FutureExecution,
	request: NormalizedScheduledLaunchInput,
	existingPayload: FutureLaunchPayload,
): Resolved<{
	title: string | null;
	launcherInput: Record<string, unknown>;
	modelConfig: LauncherModelConfigDefaults;
	schedule: ParsedScheduleRequest;
	actor: Actor | null;
}> {
	const schedule = request.scheduleProvided
		? ({ ok: true, value: request.schedule } as const)
		: resolveStoredScheduleRequest(execution);
	if (!schedule.ok) return schedule;
	return {
		ok: true,
		value: {
			title: request.titleProvided ? request.title : existingPayload.launchPlan.processInput.title,
			launcherInput: request.launcherInputProvided
				? request.launcherInput
				: existingPayload.launcherInput,
			modelConfig: request.modelConfigProvided ? request.modelConfig : existingPayload.modelConfig,
			schedule: schedule.value,
			actor: existingPayload.actor,
		},
	};
}

function resolveScheduledActionUpdateRequest(
	execution: FutureExecution,
	request: NormalizedScheduledActionInput,
): Resolved<{
	input: Record<string, unknown>;
	nextTurnModelProfileId: string | null;
	schedule: ParsedScheduleRequest;
	actor: Actor | null;
}> {
	const schedule = request.scheduleProvided
		? ({ ok: true, value: request.schedule } as const)
		: resolveStoredScheduleRequest(execution);
	if (!schedule.ok) return schedule;
	const needsExistingPayload = !request.inputProvided || !request.nextTurnModelProfileIdProvided;
	let existingPayload: FutureActionPayload | null = null;
	if (needsExistingPayload) {
		const parsedPayload = parseFutureActionPayloadJson(execution.payloadJson);
		if (!parsedPayload.ok) {
			return {
				ok: false,
				issue: { code: "invalid_payload", message: "Scheduled action payload is invalid" },
			};
		}
		existingPayload = parsedPayload.value;
	}
	return {
		ok: true,
		value: {
			input: request.inputProvided ? request.input : (existingPayload?.input ?? {}),
			nextTurnModelProfileId: request.nextTurnModelProfileIdProvided
				? (request.nextTurnModelProfileId ?? null)
				: (existingPayload?.nextTurnModelProfileId ?? null),
			schedule: schedule.value,
			actor: existingPayload?.actor ?? null,
		},
	};
}

function buildFutureExecutionTitleEffects(
	futureExecution: FutureExecution,
	launchPlan: ProcessLaunchPlan,
	operation: "created" | "updated",
) {
	return [
		buildFutureExecutionUpdatedEffect(futureExecution, operation),
		buildQueueFutureExecutionTitleEffect(futureExecution, launchPlan),
	];
}

async function validateScheduledActionRequest(
	deps: FutureExecutionLifecycleDeps,
	process: ProcessInstance,
	actionId: string,
	input: Record<string, unknown>,
	nextTurnModelProfileId?: string | null,
): Promise<
	| { ok: true; actionLabel: string; candidateSelectedTurnId: string | null }
	| { ok: false; outcome: LifecycleFailure }
> {
	const registry = deps.processActionRegistry;
	if (!registry) {
		return {
			ok: false,
			outcome: { kind: "unavailable", reason: "Process action registry is not available" },
		};
	}
	const validation = await preflightScheduledActionRequest({
		processGraphs: deps.processGraphs ?? new Map(),
		processActionRegistry: registry,
		process,
		projects: deps.projects.listByInstance(process.id),
		turnRecords: deps.turnRecords,
		actionId,
		actionInput: input,
		nextTurnModelProfileId,
	});
	if (!validation.ok) {
		if (validation.code === "action_not_found") {
			return {
				ok: false,
				outcome: { kind: "not_found", target: "action" },
			};
		}
		return {
			ok: false,
			outcome:
				validation.code === "action_not_visible"
					? {
							kind: "conflict",
							issue: { code: validation.code, message: validation.error },
						}
					: {
							kind: "invalid",
							issues: [{ code: validation.code, message: validation.error }],
						},
		};
	}
	if (typeof nextTurnModelProfileId === "string") {
		const result = deps.processModelPolicy.evaluate({
			kind: "runtime_selection",
			availability: deps.modelStatusCache.snapshot(),
			processId: process.processId,
			selection: {
				modelProfileId: nextTurnModelProfileId,
				provenance: { kind: "explicit", source: "action_override" },
			},
		});
		if (!result.ok && result.code !== "model_unavailable" && result.code !== "model_stale") {
			return {
				ok: false,
				outcome: {
					kind: "invalid",
					issues: [
						{
							code: "invalid_model_profile",
							message: presentProcessModelPolicyFailure(result),
						},
					],
				},
			};
		}
	}
	return {
		ok: true,
		actionLabel: validation.actionLabel,
		candidateSelectedTurnId: validation.candidateSelectedTurnId,
	};
}

function launchFailureIssue(
	result: Exclude<Awaited<ReturnType<typeof createProcessFromLaunchPlan>>, { ok: true }>,
): FutureExecutionIssue {
	return {
		code: typeof result.body.code === "string" ? result.body.code : "process_launch_failed",
		message: typeof result.body.error === "string" ? result.body.error : "Failed to launch process",
	};
}

function launchFailureOutcome(
	result: Exclude<Awaited<ReturnType<typeof createProcessFromLaunchPlan>>, { ok: true }>,
): LaunchMutationOutcome {
	const issue = launchFailureIssue(result);
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

function actionFailureOutcome(
	result: Exclude<Awaited<ReturnType<ProcessEngine["executeProcessAction"]>>, { ok: true }>,
): ActionMutationOutcome {
	const issue = {
		code: result.code ?? "action_execution_failed",
		message: result.error,
	};
	if (result.stage === "post_commit") {
		return {
			kind: "committed_with_reaction_error",
			process: result.process,
			error: issue.message,
			...(issue.code ? { code: issue.code } : {}),
		};
	}
	if (
		issue.code === "not_found" ||
		issue.code === "process_not_found" ||
		issue.code === "action_not_found"
	) {
		return {
			kind: "not_found",
			target: issue.code === "action_not_found" ? "action" : "process",
		};
	}
	if (issue.code === "action_not_visible" || issue.code === "action_locked_by_schedule") {
		return { kind: "conflict", issue };
	}
	if (isInternalEngineFailureCode(issue.code)) {
		return { kind: "failed", issue };
	}
	return { kind: "invalid", issues: [issue] };
}

function invalidOutcome(
	code: string,
	message: string,
): Extract<LifecycleFailure, { kind: "invalid" }> {
	return { kind: "invalid", issues: [{ code, message }] };
}

function resolveSelectedSkills(
	skills: FutureExecutionLifecycleDeps["skills"],
	ids: readonly string[],
):
	| { ok: true; value: readonly SkillSelection[] }
	| { ok: false; outcome: Extract<LifecycleFailure, { kind: "invalid" }> } {
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
): Extract<LaunchMutationOutcome, { kind: "invalid" }> {
	return {
		kind: "invalid",
		issues: result.errors.map((issue) => ({
			code: issue.code,
			message: issue.message,
			...(issue.fieldId !== undefined ? { fieldId: issue.fieldId } : {}),
		})),
	};
}

async function executeActionMutation(
	commands: ProcessEngine,
	process: ProcessInstance,
	actionId: string,
	input: Record<string, unknown>,
	opts?: Parameters<ProcessEngine["executeProcessAction"]>[3],
): Promise<ActionMutationOutcome> {
	const result = await commands.executeProcessAction(process.id, actionId, input, opts);
	return result.ok
		? {
				kind: "executed",
				process: result.process ?? process,
				...(result.data ? { data: result.data } : {}),
			}
		: actionFailureOutcome(result);
}

export function createFutureExecutionLifecycle(
	deps: FutureExecutionLifecycleDeps,
	_options: FutureExecutionLifecycleOptions = {},
) {
	const nowFn = _options.now ?? (() => new Date());
	const executor = createFutureExecutionExecutor(deps);
	const evaluateFutureSelection = (input: {
		process: ProcessInstance;
		turnId: string | null;
		overrideProvided?: boolean;
		overrideModelProfileId?: string | null;
		operationTime: Date;
	}) =>
		evaluateFutureModelSelection({
			...input,
			policy: deps.processModelPolicy,
			availability: deps.modelStatusCache.snapshot(),
			detectedAt: input.operationTime.toISOString(),
		});
	const launchPlanSelectionState = (launchPlan: ProcessLaunchPlan, operationTime: Date) =>
		projectLaunchPlanModelState(launchPlan, {
			policy: deps.processModelPolicy,
			availability: deps.modelStatusCache.snapshot(),
			detectedAt: operationTime.toISOString(),
		});

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

	type ValidatedLaunchSchedule =
		| { mode: "now"; nextRunAt: null; cronExpression: null }
		| { mode: "once"; nextRunAt: string; cronExpression: null }
		| { mode: "cron"; nextRunAt: string; cronExpression: string };

	async function prepareScheduledLaunch(input: {
		baseLaunchPlan: ProcessLaunchPlan;
		modelConfig: LauncherModelConfigDefaults;
		title: string | null;
		titleProvided: boolean;
		schedule: ParsedScheduleRequest;
		operationTime: Date;
	}): Promise<
		| {
				ok: true;
				launchPlan: ProcessLaunchPlan;
				modelState: ReturnType<typeof launchPlanSelectionState>;
				schedule: ValidatedLaunchSchedule;
		  }
		| { ok: false; outcome: Extract<LaunchMutationOutcome, { kind: "invalid" }> }
	> {
		const schedule = validateScheduleRequestInput(input.schedule, ["now", "once", "cron"], {
			resolveCronNextRunAt: (expression) => nextCronOccurrenceUtc(expression, input.operationTime),
		});
		if (!schedule.ok) {
			return {
				ok: false,
				outcome: invalidOutcome("invalid_schedule", schedule.error),
			};
		}
		const prepared = await deps.launchPlans.prepare(input.baseLaunchPlan, {
			modelConfig: normalizeLaunchModelConfigInput(input.modelConfig),
			invalidModelConfig: "reject",
		});
		if (!prepared.ok) {
			if (schedule.value.mode === "now") {
				return {
					ok: false,
					outcome: {
						kind: "invalid",
						issues: presentLaunchPlanPreparationIssues(prepared.errors),
					},
				};
			}
			const launchPlan = applySubmittedProcessTitleToLaunchPlan(prepared.launchPlan, input);
			const modelState = launchPlanSelectionState(launchPlan, input.operationTime);
			if (!modelState.blockedReason) {
				return {
					ok: false,
					outcome: {
						kind: "invalid",
						issues: presentLaunchPlanPreparationIssues(prepared.errors),
					},
				};
			}
			return { ok: true, launchPlan, modelState, schedule: schedule.value };
		}
		const launchPlan = applySubmittedProcessTitleToLaunchPlan(prepared.launchPlan, input);
		return {
			ok: true,
			launchPlan,
			modelState: launchPlanSelectionState(launchPlan, input.operationTime),
			schedule: schedule.value,
		};
	}

	async function persistScheduledLaunch(input: {
		existing?: FutureExecution;
		processId: string;
		launcherId: string;
		launcherInput: Record<string, unknown>;
		modelConfig: LauncherModelConfigDefaults;
		actor: Actor;
		launchPlan: ProcessLaunchPlan;
		selectedSkillIds: readonly string[];
		resourceSelections: readonly SkillSelection[];
		modelState: ReturnType<typeof launchPlanSelectionState>;
		schedule: Exclude<ValidatedLaunchSchedule, { mode: "now" }>;
	}): Promise<LaunchMutationOutcome> {
		const values = {
			scheduleKind: input.schedule.mode === "cron" ? ("cron" as const) : ("once" as const),
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
		const futureExecution = input.existing
			? deps.futureExecutions.update(input.existing.id, values)
			: deps.futureExecutions.create({ kind: "launch", ...values });
		if (!futureExecution) {
			return { kind: "not_found", target: "launch" };
		}
		const operation = input.existing ? "updated" : "created";
		const reaction = await runFutureExecutionPostCommitEffects(
			deps,
			buildFutureExecutionTitleEffects(futureExecution, input.launchPlan, operation),
		);
		recordLauncherRecentsBestEffort(input.launcherId, input.launcherInput);
		return reaction.ok
			? { kind: "scheduled", execution: futureExecution, operation }
			: {
					kind: "committed_with_reaction_error",
					execution: futureExecution,
					operation,
					error: reaction.message,
					code: reaction.code,
				};
	}

	async function upsertScheduledAction(input: {
		existing?: FutureExecution;
		process: ProcessInstance;
		actionId: string;
		actionInput: Record<string, unknown>;
		nextTurnModelProfileId: string | null;
		overrideProvided: boolean;
		actor: Actor;
		nextRunAt: string;
		operationTime: Date;
	}): Promise<ActionMutationOutcome> {
		const validation = await validateScheduledActionRequest(
			deps,
			input.process,
			input.actionId,
			input.actionInput,
			typeof input.nextTurnModelProfileId === "string" ? input.nextTurnModelProfileId : undefined,
		);
		if (!validation.ok) return validation.outcome;
		const modelState = evaluateFutureSelection({
			process: input.process,
			turnId: validation.candidateSelectedTurnId,
			overrideProvided: input.overrideProvided,
			overrideModelProfileId: input.nextTurnModelProfileId,
			operationTime: input.operationTime,
		});
		const payloadJson = serializeFutureActionPayload({
			input: input.actionInput,
			nextTurnModelProfileId: input.nextTurnModelProfileId,
			actionLabel: validation.actionLabel,
			actor: input.actor,
		});
		const futureExecution = input.existing
			? deps.futureExecutions.update(input.existing.id, {
					payloadJson,
					nextRunAt: input.nextRunAt,
					...modelState,
				})
			: deps.futureExecutions.create({
					kind: "action",
					scheduleKind: "once",
					processId: input.process.processId,
					instanceId: input.process.id,
					actionId: input.actionId,
					payloadJson,
					nextRunAt: input.nextRunAt,
					...modelState,
				});
		if (!futureExecution) {
			return { kind: "not_found", target: "action" };
		}
		const operation = input.existing ? "updated" : "created";
		const reaction = await runFutureExecutionPostCommitEffects(deps, [
			buildFutureExecutionUpdatedEffect(futureExecution, operation),
		]);
		return reaction.ok
			? {
					kind: "scheduled",
					execution: futureExecution,
					instanceId: input.process.id,
					operation,
				}
			: {
					kind: "committed_with_reaction_error",
					execution: futureExecution,
					instanceId: input.process.id,
					operation,
					error: reaction.message,
					code: reaction.code,
				};
	}

	async function removeExecution(execution: FutureExecution) {
		if (!deps.futureExecutions.delete(execution.id)) return { ok: true } as const;
		return runFutureExecutionPostCommitEffects(deps, [
			buildFutureExecutionUpdatedEffect(execution, "deleted"),
		]);
	}

	async function executeDueRows(
		rows: readonly FutureExecution[],
		asOf: string,
		execute: (futureExecutionId: string, asOf: string) => Promise<FutureExecutionItemOutcome>,
		logMessage: string,
	): Promise<FutureExecutionDueItemOutcome[]> {
		const items: FutureExecutionDueItemOutcome[] = [];
		for (const execution of rows) {
			try {
				const outcome = await execute(execution.id, asOf);
				items.push({ futureExecutionId: execution.id, ...outcome });
			} catch (error) {
				deps.logger?.error?.({ err: error, futureExecutionId: execution.id, asOf }, logMessage);
				items.push({
					futureExecutionId: execution.id,
					kind: "unexpected_error",
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		return items;
	}

	return {
		async scheduleLaunch(
			launcherId: string,
			request: NormalizedScheduledLaunchInput,
			opts?: {
				actor?: Actor;
				launchRunId?: string;
				resolvedLauncher?: ResolvedProcessLauncher;
			},
		): Promise<LaunchMutationOutcome> {
			const operationTime = nowFn();
			if (!deps.launcherService) {
				return { kind: "unavailable", reason: "Launcher service is not available" };
			}
			const resolved = opts?.resolvedLauncher
				? { ok: true as const, launcher: opts.resolvedLauncher }
				: await deps.launcherService.resolveUiLauncher(launcherId, request.launcherInput);
			if (!resolved.ok) {
				return launcherResolutionFailure(resolved);
			}
			const modelLaunchPlan = request.modelConfigProvided
				? clearLaunchPlanModelConfig(resolved.launcher.launchPlan)
				: resolved.launcher.launchPlan;
			const resourceSelections = resolveSelectedSkills(deps.skills, request.skillIds ?? []);
			if (!resourceSelections.ok) return resourceSelections.outcome;
			const prepared = await prepareScheduledLaunch({
				baseLaunchPlan: modelLaunchPlan,
				modelConfig: request.modelConfig,
				title: request.title,
				titleProvided: request.titleProvided,
				schedule: request.schedule,
				operationTime,
			});
			if (!prepared.ok) return prepared.outcome;
			const { launchPlan, modelState, schedule } = prepared;
			if (schedule.mode !== "now") {
				return persistScheduledLaunch({
					processId: resolved.launcher.processId,
					launcherId: resolved.launcher.launcherId,
					launcherInput: request.launcherInput,
					modelConfig: request.modelConfig,
					actor: opts?.actor ?? SYSTEM_ACTOR,
					launchPlan,
					selectedSkillIds: request.skillIds ?? [],
					resourceSelections: resourceSelections.value,
					modelState,
					schedule,
				});
			}
			const created = await createProcessFromLaunchPlan(deps, launchPlan, {
				...opts,
				resourceSelections: resourceSelections.value,
				launchIntent: { launcherInput: request.launcherInput },
			});
			if (!created.ok) {
				return launchFailureOutcome(created);
			}
			recordLauncherRecentsBestEffort(resolved.launcher.launcherId, request.launcherInput);
			return {
				kind: "launched",
				process: created.process,
				projects: created.projects,
				operation: "created",
			};
		},

		async reviseScheduledLaunch(
			futureExecutionId: string,
			request: NormalizedScheduledLaunchInput,
			opts?: { actor?: Actor },
		): Promise<LaunchMutationOutcome> {
			const operationTime = nowFn();
			return runFutureExecutionExclusive(deps.processOperations, futureExecutionId, async () => {
				if (!deps.launcherService) {
					return { kind: "unavailable", reason: "Launcher service is not available" };
				}
				const existing = deps.futureExecutions.getById(futureExecutionId);
				if (!existing || existing.kind !== "launch") {
					return { kind: "not_found", target: "launch" };
				}
				const parsedPayload = parseFutureLaunchPayloadJson(existing.payloadJson);
				if (!parsedPayload.ok) {
					return invalidOutcome("invalid_payload", "Scheduled launch payload is invalid");
				}
				const existingPayload = parsedPayload.value;
				const launchRequest = resolveScheduledLaunchUpdateRequest(
					existing,
					request,
					existingPayload,
				);
				if (!launchRequest.ok) return { kind: "invalid", issues: [launchRequest.issue] };
				const resolved = await deps.launcherService.resolveUiLauncher(
					existing.launcherId ?? existingPayload.launchPlan.launcherId,
					launchRequest.value.launcherInput,
				);
				if (!resolved.ok) {
					return launcherResolutionFailure(resolved);
				}
				let baseLaunchPlan = resolved.launcher.launchPlan;
				const resourceSelections = request.skillIds
					? resolveSelectedSkills(deps.skills, request.skillIds)
					: { ok: true as const, value: existingPayload.resourceSelections };
				if (!resourceSelections.ok) return resourceSelections.outcome;
				if (request.modelConfigProvided) {
					baseLaunchPlan = clearLaunchPlanModelConfig(baseLaunchPlan);
				} else {
					baseLaunchPlan = applyStoredLaunchPlanModelConfig(
						baseLaunchPlan,
						existingPayload.launchPlan.processInput,
					);
				}
				const prepared = await prepareScheduledLaunch({
					baseLaunchPlan,
					modelConfig: launchRequest.value.modelConfig,
					title: launchRequest.value.title,
					titleProvided: true,
					schedule: launchRequest.value.schedule,
					operationTime,
				});
				if (!prepared.ok) return prepared.outcome;
				const { launchPlan, modelState, schedule } = prepared;
				if (schedule.mode === "now") {
					const launchActor = opts?.actor ?? launchRequest.value.actor ?? SYSTEM_ACTOR;
					const created = await createScheduledProcessFromLaunchPlan(
						deps,
						launchPlan,
						planConsumeFutureExecution(existing),
						{
							actor: launchActor,
							resourceSelections: resourceSelections.value,
							launchIntent: { launcherInput: launchRequest.value.launcherInput },
						},
					);
					const reaction =
						created.ok || created.stage === "post_commit"
							? await runFutureExecutionPostCommitEffects(deps, [
									buildFutureExecutionUpdatedEffect(existing, "deleted"),
								])
							: null;
					if (!created.ok) return launchFailureOutcome(created);
					if (reaction && !reaction.ok) {
						return {
							kind: "committed_with_reaction_error",
							process: created.process,
							projects: created.projects,
							error: reaction.message,
							code: reaction.code,
						};
					}
					recordLauncherRecentsBestEffort(
						resolved.launcher.launcherId,
						launchRequest.value.launcherInput,
					);
					return {
						kind: "launched",
						process: created.process,
						projects: created.projects,
						operation: "updated",
					};
				}
				return persistScheduledLaunch({
					existing,
					processId: resolved.launcher.processId,
					launcherId: resolved.launcher.launcherId,
					launcherInput: launchRequest.value.launcherInput,
					modelConfig: launchRequest.value.modelConfig,
					actor: opts?.actor ?? launchRequest.value.actor ?? SYSTEM_ACTOR,
					launchPlan,
					selectedSkillIds: request.skillIds ?? existingPayload.selectedSkillIds,
					resourceSelections: resourceSelections.value,
					modelState,
					schedule,
				});
			});
		},

		async scheduleAction(
			process: ProcessInstance,
			actionId: string,
			request: NormalizedScheduledActionInput,
			opts?: { actor?: Actor },
		): Promise<ActionMutationOutcome> {
			const operationTime = nowFn();
			const scheduleValidation = validateScheduleRequestInput(request.schedule, ["now", "once"]);
			if (!scheduleValidation.ok) {
				return invalidOutcome("invalid_schedule", scheduleValidation.error);
			}
			const validatedSchedule = scheduleValidation.value;
			if (validatedSchedule.mode === "once") {
				return deps.processOperations.runExclusive(
					process.id,
					async (): Promise<ActionMutationOutcome> => {
						const lockedProcess = deps.processes.getById(process.id);
						if (!lockedProcess) {
							return { kind: "not_found", target: "process" };
						}
						if (deps.futureExecutions.getScheduledActionByInstance(process.id)) {
							return {
								kind: "conflict",
								issue: {
									code: "action_locked_by_schedule",
									message: "This process already has a scheduled action",
								},
							};
						}
						return upsertScheduledAction({
							process: lockedProcess,
							actionId,
							actionInput: request.input,
							nextTurnModelProfileId:
								typeof request.nextTurnModelProfileId === "string"
									? request.nextTurnModelProfileId
									: null,
							overrideProvided: typeof request.nextTurnModelProfileId === "string",
							actor: opts?.actor ?? SYSTEM_ACTOR,
							nextRunAt: validatedSchedule.nextRunAt,
							operationTime,
						});
					},
				);
			}
			return executeActionMutation(deps.commands, process, actionId, request.input, {
				...(typeof request.nextTurnModelProfileId === "string"
					? { nextTurnModelProfileId: request.nextTurnModelProfileId }
					: {}),
				...(opts?.actor ? { actor: opts.actor } : {}),
			});
		},

		async reviseScheduledAction(
			futureExecutionId: string,
			request: NormalizedScheduledActionInput,
			opts?: { actor?: Actor },
		): Promise<ActionMutationOutcome> {
			const operationTime = nowFn();
			return runFutureExecutionExclusive(
				deps.processOperations,
				futureExecutionId,
				async (): Promise<ActionMutationOutcome> => {
					const existing = deps.futureExecutions.getById(futureExecutionId);
					if (
						!existing ||
						existing.kind !== "action" ||
						!existing.instanceId ||
						!existing.actionId
					) {
						return {
							kind: "not_found",
							target: "action",
						};
					}
					const resolvedActionRequest = resolveScheduledActionUpdateRequest(existing, request);
					if (!resolvedActionRequest.ok) {
						return { kind: "invalid", issues: [resolvedActionRequest.issue] };
					}
					const scheduleValidation = validateScheduleRequestInput(
						resolvedActionRequest.value.schedule,
						["now", "once"],
					);
					if (!scheduleValidation.ok) {
						return invalidOutcome("invalid_schedule", scheduleValidation.error);
					}
					const validatedSchedule = scheduleValidation.value;
					const process = deps.processes.getById(existing.instanceId);
					if (!process) {
						return { kind: "not_found", target: "process" };
					}
					if (validatedSchedule.mode === "now") {
						return executeActionMutation(
							deps.commands,
							process,
							existing.actionId,
							resolvedActionRequest.value.input,
							{
								...(typeof resolvedActionRequest.value.nextTurnModelProfileId === "string"
									? { nextTurnModelProfileId: resolvedActionRequest.value.nextTurnModelProfileId }
									: {}),
								source: "scheduled",
								scheduledExecutionId: existing.id,
								consumeScheduledExecutionOnSuccess: true,
								actor: opts?.actor ?? resolvedActionRequest.value.actor ?? SYSTEM_ACTOR,
							},
						);
					}
					const scheduledResult = await deps.processOperations.runExclusive(
						existing.instanceId,
						async (): Promise<ActionMutationOutcome> => {
							const lockedExisting = deps.futureExecutions.getById(futureExecutionId);
							if (
								!lockedExisting ||
								lockedExisting.kind !== "action" ||
								!lockedExisting.instanceId ||
								!lockedExisting.actionId
							) {
								return {
									kind: "not_found",
									target: "action",
								};
							}
							const lockedProcess = deps.processes.getById(lockedExisting.instanceId);
							if (!lockedProcess) {
								return { kind: "not_found", target: "process" };
							}
							return upsertScheduledAction({
								existing: lockedExisting,
								process: lockedProcess,
								actionId: lockedExisting.actionId,
								actionInput: resolvedActionRequest.value.input,
								nextTurnModelProfileId: resolvedActionRequest.value.nextTurnModelProfileId,
								overrideProvided: resolvedActionRequest.value.nextTurnModelProfileId !== null,
								actor: opts?.actor ?? resolvedActionRequest.value.actor ?? SYSTEM_ACTOR,
								nextRunAt: validatedSchedule.nextRunAt,
								operationTime,
							});
						},
					);
					return scheduledResult;
				},
			);
		},

		async cancel(futureExecutionId: string): Promise<CancelFutureExecutionOutcome> {
			return runFutureExecutionExclusive(deps.processOperations, futureExecutionId, async () => {
				const execution = deps.futureExecutions.getById(futureExecutionId);
				if (!execution) {
					return { kind: "not_found", target: "future_execution" };
				}
				const reaction = await removeExecution(execution);
				return reaction.ok
					? { kind: "canceled", execution }
					: {
							kind: "committed_with_reaction_error",
							execution,
							error: reaction.message,
							code: reaction.code,
						};
			});
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
					if (!current || current.kind !== "launch") {
						return { kind: "superseded" };
					}
					if (current.payloadJson !== input.expectedPayloadJson) {
						return { kind: "superseded" };
					}
					const parsedPayload = parseFutureLaunchPayloadJson(current.payloadJson);
					if (!parsedPayload.ok) {
						return { kind: "failed", error: parsedPayload.error };
					}
					const payload = parsedPayload.value;
					if (normalizeProcessTitleInput(payload.launchPlan.processInput.title)) {
						return { kind: "superseded" };
					}
					const updated = deps.futureExecutions.updatePayloadJsonIfUnchanged(
						current.id,
						current.payloadJson,
						serializeFutureLaunchPayload({
							...payload,
							launchPlan: {
								...payload.launchPlan,
								processInput: { ...payload.launchPlan.processInput, title: input.title },
							},
						}),
					);
					if (!updated) {
						return { kind: "superseded" };
					}
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

		async reconcileModelAvailability(input: {
			availability: ModelStatusCacheSnapshot;
			profileIds?: ReadonlySet<string>;
			asOf?: string;
		}) {
			const asOf = input.asOf ?? nowFn().toISOString();
			if (!deps.processGraphs || !deps.processActionRegistry) {
				throw new Error("Future execution model reconciliation dependencies are unavailable");
			}
			const result = await reconcileFutureExecutionModelBlocks({
				futureExecutions: deps.futureExecutions,
				processes: deps.processes,
				projects: deps.projects,
				turnRecords: deps.turnRecords,
				processGraphs: deps.processGraphs,
				processActionRegistry: deps.processActionRegistry,
				processOperations: deps.processOperations,
				policy: deps.processModelPolicy,
				availability: input.availability,
				getModelAvailabilitySnapshot: () => deps.modelStatusCache.snapshot(),
				...(input.profileIds ? { profileIds: input.profileIds } : {}),
				broadcaster: deps.broadcaster,
				processTitles: deps.processTitles,
				asOf,
			});
			return result.reaction.ok
				? { kind: "reconciled", changed: result.changed, asOf }
				: {
						kind: "committed_with_reaction_error",
						changed: result.changed,
						asOf,
						error: result.reaction.message,
						code: result.reaction.code,
					};
		},

		async reconcileMissedScheduleOccurrences(
			asOf: string,
		): Promise<{ kind: "occurrences_advanced"; asOf: string }> {
			await executor.reconcileMissedCronRowsOnStartup(asOf);
			return { kind: "occurrences_advanced", asOf };
		},

		async runDueWork(asOf: string): Promise<FutureExecutionDueBatchOutcome> {
			const blockedItems = await executeDueRows(
				deps.futureExecutions.listBlockedCronDue(asOf),
				asOf,
				executor.advanceBlockedCronItem,
				"Unexpected blocked future execution advancement failure",
			);
			const runnableItems = await executeDueRows(
				deps.futureExecutions.listRunnableDue(asOf),
				asOf,
				executor.executeDueItem,
				"Unexpected future execution failure",
			);
			const items = [...blockedItems, ...runnableItems];
			return { kind: "batch_completed", asOf, items };
		},
	};
}

export type FutureExecutionLifecycle = ReturnType<typeof createFutureExecutionLifecycle>;
