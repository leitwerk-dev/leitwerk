import {
	type Actor,
	type FutureExecution,
	type ProcessInstance,
	SYSTEM_ACTOR,
} from "@leitwerk-dev/domain";
import type {
	ProcessLauncherService,
	ProcessLaunchPlanServiceLike,
} from "@leitwerk-dev/process-sdk";
import {
	type FutureActionPayload,
	type ParsedScheduleRequest,
	parseFutureActionPayloadJson,
	serializeFutureActionPayload,
	validateScheduleRequestInput,
} from "@leitwerk-dev/protocol";
import type { RepositoryBundle } from "../db/repositories.js";
import type { ExtensionHost } from "../extensions/extension-host.js";
import type { LauncherRecentValuesService } from "../launcher-recent-values-service.js";
import type {
	ModelStatusCache,
	ModelStatusCacheSnapshot,
} from "../model-providers/model-status-cache.js";
import type { ProcessActionRegistry } from "../process-action-registry.js";
import { isInternalEngineFailureCode } from "../process-engine/internal-failures.js";
import type { ProcessEngine, ProcessEngineLogger } from "../process-engine/types.js";
import type { ProcessGraphRegistry } from "../process-graph.js";
import type { ServerProcessModelPolicy } from "../process-model-policy/index.js";
import { presentProcessModelPolicyFailure } from "../process-model-policy-presenter.js";
import type { ProcessOperationCoordinator } from "../process-operation-coordinator.js";
import type { ProcessTitleGenerator } from "../process-title-generator.js";
import { preflightScheduledActionRequest } from "../scheduled-action-preflight.js";
import type { Broadcaster } from "../ws/broadcast.js";
import { createFutureExecutionExecutor, type FutureExecutionItemOutcome } from "./execution.js";
import { createFutureLaunchLifecycle, type FutureExecutionIssue } from "./launch-lifecycle.js";
import { evaluateFutureModelSelection } from "./model-projection.js";
import { reconcileFutureExecutionModelBlocks } from "./reconciliation.js";
import {
	buildFutureExecutionUpdatedEffect,
	resolveStoredScheduleRequest,
	runFutureExecutionExclusive,
	runFutureExecutionPostCommitEffects,
} from "./support.js";

export type {
	FutureExecutionIssue,
	LaunchMutationOutcome,
	NormalizedScheduledLaunchInput,
	PreparedLaunch,
	PreparedLaunchResult,
} from "./launch-lifecycle.js";

export interface FutureExecutionLifecycleDeps
	extends Pick<
		RepositoryBundle,
		| "futureExecutions"
		| "processes"
		| "projects"
		| "processRelations"
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
	launchPipeline: import("../launch-pipeline.js").LaunchPipeline;
	logger?: ProcessEngineLogger;
}

export interface FutureExecutionLifecycleOptions {
	now?: () => Date;
}

type LifecycleFailure =
	| { kind: "invalid"; issues: readonly FutureExecutionIssue[] }
	| { kind: "not_found"; target: "future_execution" | "launch" | "action" | "process" }
	| { kind: "conflict"; issue: FutureExecutionIssue }
	| { kind: "unavailable"; reason: string }
	| { kind: "failed"; issue: FutureExecutionIssue };

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

export interface NormalizedScheduledActionInput {
	input: Record<string, unknown>;
	inputProvided: boolean;
	nextTurnModelProfileId?: string | null;
	nextTurnModelProfileIdProvided: boolean;
	schedule: ParsedScheduleRequest;
	scheduleProvided: boolean;
}

type Resolved<T> = { ok: true; value: T } | { ok: false; issue: FutureExecutionIssue };

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
	if (
		issue.code === "action_not_visible" ||
		issue.code === "action_locked_by_schedule" ||
		issue.code === "session_transfer_in_progress"
	) {
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
	const launchLifecycle = createFutureLaunchLifecycle(deps, { now: nowFn });
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
		prepareLaunch: launchLifecycle.prepareLaunch,

		commitPreparedLaunch: launchLifecycle.commitPreparedLaunch,

		reviseScheduledLaunch: launchLifecycle.reviseScheduledLaunch,

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

		applyGeneratedFutureLaunchTitleIfUnchanged:
			launchLifecycle.applyGeneratedFutureLaunchTitleIfUnchanged,

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
