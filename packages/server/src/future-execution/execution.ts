import type { FutureExecution } from "@leitwerk-dev/domain";
import type { ProcessLaunchPlan, ProcessLaunchPlanServiceLike } from "@leitwerk-dev/process-sdk";
import {
	type FutureLaunchPayload,
	parseFutureActionPayloadJson,
	parseFutureLaunchPayloadJson,
} from "@leitwerk-dev/protocol";
import type { RepositoryBundle } from "../db/repositories.js";
import { nextCronOccurrenceUtc } from "../domain-logic/cron.js";
import type { PostCommitEffect } from "../effects/post-commit-effect.js";
import type { ExtensionHost } from "../extensions/extension-host.js";
import { scheduledLaunchOccurrenceKey } from "../launch-idempotency.js";
import type { LaunchPipeline } from "../launch-pipeline.js";
import type { ModelStatusCache } from "../model-providers/model-status-cache.js";
import type { ProcessActionRegistry } from "../process-action-registry.js";
import type { ProcessEngine, ProcessEngineLogger } from "../process-engine/types.js";
import type { ProcessGraphRegistry } from "../process-graph.js";
import { createScheduledProcessFromLaunchPlan } from "../process-launch-executor.js";
import { toLaunchPipelineCommit } from "../process-launch-pipeline-adapter.js";
import type { ServerProcessModelPolicy } from "../process-model-policy/index.js";
import type { ProcessOperationCoordinator } from "../process-operation-coordinator.js";
import type { ProcessTitleGenerator } from "../process-title-generator.js";
import type { Broadcaster } from "../ws/broadcast.js";
import {
	projectFutureExecutionModelState,
	toFutureExecutionBlockReason,
} from "./model-projection.js";
import {
	buildFutureExecutionUpdatedEffect,
	runFutureExecutionExclusive,
	runFutureExecutionPostCommitEffects,
} from "./support.js";
import {
	applyFutureExecutionTransitionPlan,
	type FutureExecutionTransitionPlan,
	planAdvanceFutureExecution,
	planBlockFutureExecution,
	planConsumeFutureExecution,
	planRetryFutureExecution,
} from "./transition-planner.js";

const ONE_TIME_FAILURE_RETRY_DELAY_MS = 60_000;

export interface FutureExecutionExecutorDeps
	extends Pick<
		RepositoryBundle,
		| "futureExecutions"
		| "processes"
		| "projects"
		| "processRelations"
		| "processSkills"
		| "skills"
		| "handoffDedupKeys"
		| "transaction"
	> {
	turnRecords?: RepositoryBundle["turnRecords"];
	broadcaster: Broadcaster;
	commands: ProcessEngine;
	processOperations: ProcessOperationCoordinator;
	processTitles?: ProcessTitleGenerator;
	extensionHost?: ExtensionHost;
	processGraphs?: ProcessGraphRegistry;
	processActionRegistry?: ProcessActionRegistry;
	/** Required for every server-owned scheduled execution. */
	processModelPolicy: ServerProcessModelPolicy;
	launchPlans: ProcessLaunchPlanServiceLike;
	modelStatusCache: Pick<ModelStatusCache, "snapshot">;
	launchPipeline: LaunchPipeline;
	logger?: ProcessEngineLogger;
}

export type FutureExecutionDisposition =
	| {
			kind: "committed";
			dispositionApplied: boolean;
			reactionError?: Error;
	  }
	| { kind: "retry_later"; error: Error }
	| { kind: "remove"; error?: Error };

export type FutureExecutionItemOutcome =
	| { kind: "no_work" }
	| { kind: "blocked" }
	| { kind: "retry_scheduled" }
	| { kind: "occurrence_advanced" }
	| { kind: "terminal_invalid_removed" }
	| { kind: "durable_work_committed" }
	| { kind: "durable_work_committed_with_reaction_error"; error: string };

function toError(error: unknown, fallbackMessage: string): Error {
	return error instanceof Error ? error : new Error(fallbackMessage);
}

function isTerminalScheduledActionFailureCode(code: string | undefined): boolean {
	return (
		code === "not_found" ||
		code === "action_not_found" ||
		code === "action_not_visible" ||
		code === "scheduled_action_missing" ||
		code === "action_locked_by_schedule"
	);
}

function computeNextCronRun(execution: FutureExecution, after: Date): string {
	if (!execution.cronExpression) {
		throw new Error(`Cron execution '${execution.id}' is missing its cron expression`);
	}
	return nextCronOccurrenceUtc(execution.cronExpression, after);
}

async function executeScheduledLaunch(
	deps: FutureExecutionExecutorDeps,
	execution: FutureExecution,
): Promise<FutureExecutionDisposition> {
	const opened = deps.launchPipeline.open({
		launcherId: execution.launcherId,
		idempotencyKey: scheduledLaunchOccurrenceKey({
			futureExecutionId: execution.id,
			nextRunAt: execution.nextRunAt,
		}),
		origin: "scheduled",
	});
	type ScheduledPrepared = {
		payload: FutureLaunchPayload;
		launchPlan: ProcessLaunchPlan;
		transitionPlan: FutureExecutionTransitionPlan;
	};
	const result = await deps.launchPipeline.run<
		FutureLaunchPayload,
		ScheduledPrepared,
		FutureExecutionDisposition,
		FutureExecutionDisposition
	>(opened.launchRunId, {
		async resolve() {
			const parsed = parseFutureLaunchPayloadJson(execution.payloadJson);
			return parsed.ok
				? { kind: "resolved" as const, value: parsed.value }
				: {
						kind: "failed" as const,
						failure: {
							safeSummary: parsed.error,
							value: { kind: "remove" as const, error: new Error(parsed.error) },
						},
					};
		},
		async prepare(payload) {
			const prepared = await deps.launchPlans.prepare(payload.launchPlan, {
				modelConfig: payload.modelConfig,
				invalidModelConfig: "reject",
			});
			if (!prepared.ok) {
				return {
					ok: false as const,
					failure: {
						safeSummary: "The scheduled launch model configuration is unavailable.",
						value: {
							kind: "retry_later" as const,
							error: new Error(
								prepared.errors.map((item) => item.code).join("; ") ||
									`Failed to prepare scheduled launch '${execution.id}'`,
							),
						},
					},
				};
			}
			const transitionPlan =
				execution.scheduleKind === "cron"
					? planAdvanceFutureExecution(
							execution,
							computeNextCronRun(execution, new Date(execution.nextRunAt)),
						)
					: planConsumeFutureExecution(execution);
			return {
				ok: true as const,
				value: { payload, launchPlan: prepared.launchPlan, transitionPlan },
			};
		},
		async commit(prepared, ctx) {
			const created = await createScheduledProcessFromLaunchPlan(
				deps,
				prepared.launchPlan,
				prepared.transitionPlan,
				{
					...(prepared.payload.actor ? { actor: prepared.payload.actor } : {}),
					resourceSelections: prepared.payload.resourceSelections,
					launchIntent: { launcherInput: prepared.payload.launcherInput },
					launchRunId: ctx.launchRunId,
				},
			);
			const launchError = () =>
				new Error(
					!created.ok && typeof created.body.error === "string"
						? created.body.error
						: `Failed to execute scheduled launch '${execution.id}'`,
				);
			return toLaunchPipelineCommit<FutureExecutionDisposition, FutureExecutionDisposition>(
				created,
				{
					startTurnId: prepared.launchPlan.startTurnId,
					preCommitSummary: "The scheduled process could not be created. It will be retried.",
					postCommitSummary:
						"Process was created, but scheduled startup failed. Retry startup from the process page.",
					mapPreCommitFailure: () => ({ kind: "retry_later", error: launchError() }),
					mapCommittedResult: (outcome) =>
						outcome.ok
							? { kind: "committed", dispositionApplied: true }
							: {
									kind: "committed",
									dispositionApplied: true,
									reactionError: launchError(),
								},
				},
			);
		},
		unexpectedFailure(error) {
			return {
				safeSummary: "The scheduled launch could not be completed. It will be retried.",
				value: {
					kind: "retry_later",
					error: toError(error, `Failed to execute scheduled launch '${execution.id}'`),
				},
			};
		},
	});
	if (result.kind === "failed") return result.failure.value as FutureExecutionDisposition;
	if (result.kind === "skipped") return { kind: "remove" };
	return result.result;
}

async function executeScheduledAction(
	deps: FutureExecutionExecutorDeps,
	execution: FutureExecution,
): Promise<FutureExecutionDisposition> {
	if (!execution.instanceId || !execution.actionId) {
		return {
			kind: "remove",
			error: new Error(`Scheduled action '${execution.id}' is missing instanceId or actionId`),
		};
	}
	const parsedPayload = parseFutureActionPayloadJson(execution.payloadJson);
	if (!parsedPayload.ok) {
		return { kind: "remove", error: new Error(parsedPayload.error) };
	}
	const payload = parsedPayload.value;
	try {
		const result = await deps.commands.executeProcessAction(
			execution.instanceId,
			execution.actionId,
			payload.input,
			{
				source: "scheduled",
				scheduledExecutionId: execution.id,
				consumeScheduledExecutionOnSuccess: execution.scheduleKind === "once",
				...(payload.nextTurnModelProfileId !== null
					? { nextTurnModelProfileId: payload.nextTurnModelProfileId }
					: {}),
				...(payload.actor ? { actor: payload.actor } : {}),
			},
		);
		if (!result.ok) {
			const error = new Error(
				result.error ?? `Failed to execute scheduled action '${execution.id}'`,
			);
			if (result.stage === "post_commit") {
				return {
					kind: "committed",
					dispositionApplied: execution.scheduleKind === "once",
					reactionError: error,
				};
			}
			return isTerminalScheduledActionFailureCode(result.code)
				? { kind: "remove", error }
				: { kind: "retry_later", error };
		}
		return {
			kind: "committed",
			dispositionApplied: execution.scheduleKind === "once",
		};
	} catch (error) {
		return {
			kind: "retry_later",
			error: toError(error, `Failed to execute scheduled action '${execution.id}'`),
		};
	}
}

export function createFutureExecutionExecutor(deps: FutureExecutionExecutorDeps) {
	function applyTransition(
		plan: FutureExecutionTransitionPlan,
		effects: PostCommitEffect[],
	): FutureExecution | null | undefined {
		const applied = applyFutureExecutionTransitionPlan(deps.futureExecutions, plan);
		if (applied.kind === "stale") return undefined;
		effects.push(
			buildFutureExecutionUpdatedEffect(
				applied.execution ?? applied.previous,
				applied.execution ? "updated" : "deleted",
			),
		);
		return applied.execution;
	}

	function evaluateStoredSelection(execution: FutureExecution, operationTime: Date) {
		if (!execution.modelSelection) return null;
		const snapshot = deps.modelStatusCache.snapshot();
		const result = deps.processModelPolicy.evaluate({
			kind: "runtime_selection",
			availability: snapshot,
			processId: execution.processId,
			selection: execution.modelSelection,
		});
		if (result.ok) return { selection: result.selection, blockedReason: null };
		// Invalid inherited winners are re-resolved by the process operation at the
		// execution seam; they are not sticky explicit failures.
		if (
			execution.modelSelection.provenance.kind === "inherited" &&
			(result.code === "unknown_model_profile" || result.code === "model_profile_not_allowed")
		) {
			return { selection: execution.modelSelection, blockedReason: null };
		}
		return {
			selection: result.selection,
			blockedReason: toFutureExecutionBlockReason(
				result,
				operationTime.toISOString(),
				execution.blockedReason,
			),
		};
	}

	function deferOneTimeExecutionAfterFailure(
		execution: FutureExecution,
		operationTime: Date,
		effects: PostCommitEffect[],
	): void {
		const nextRunAt = new Date(
			operationTime.getTime() + ONE_TIME_FAILURE_RETRY_DELAY_MS,
		).toISOString();
		applyTransition(planRetryFutureExecution(execution, nextRunAt), effects);
	}

	async function advanceCronRows(rows: readonly FutureExecution[], currentIso: string) {
		const effects: PostCommitEffect[] = [];
		for (const execution of rows) {
			if (execution.scheduleKind !== "cron" || execution.nextRunAt > currentIso) continue;
			await runFutureExecutionExclusive(deps.processOperations, execution.id, async () => {
				const existing = deps.futureExecutions.getById(execution.id);
				if (!existing || existing.scheduleKind !== "cron" || existing.nextRunAt > currentIso)
					return;
				const nextRunAt = computeNextCronRun(existing, new Date(currentIso));
				applyTransition(planAdvanceFutureExecution(existing, nextRunAt), effects);
			});
		}
		return runFutureExecutionPostCommitEffects(deps, effects);
	}

	return {
		async reconcileMissedCronRowsOnStartup(currentIso: string): Promise<void> {
			const reaction = await advanceCronRows(
				[
					...deps.futureExecutions
						.listRunnableDue(currentIso)
						.filter((execution) => execution.nextRunAt < currentIso),
					...deps.futureExecutions.listBlockedCronDue(currentIso),
				],
				currentIso,
			);
			if (!reaction.ok) throw new Error(reaction.message);
		},

		async advanceBlockedCronItem(
			futureExecutionId: string,
			currentIso: string,
		): Promise<FutureExecutionItemOutcome> {
			const execution = deps.futureExecutions.getById(futureExecutionId);
			if (
				!execution ||
				execution.scheduleKind !== "cron" ||
				!execution.blockedReason ||
				execution.nextRunAt > currentIso
			) {
				return { kind: "no_work" };
			}
			const reaction = await advanceCronRows([execution], currentIso);
			return reaction.ok
				? { kind: "occurrence_advanced" }
				: {
						kind: "durable_work_committed_with_reaction_error",
						error: reaction.message,
					};
		},

		async executeDueItem(
			futureExecutionId: string,
			asOf: string,
		): Promise<FutureExecutionItemOutcome> {
			const operationTime = new Date(asOf);
			const effects: PostCommitEffect[] = [];
			let outcome: FutureExecutionItemOutcome = { kind: "no_work" };
			await runFutureExecutionExclusive(deps.processOperations, futureExecutionId, async () => {
				let latest = deps.futureExecutions.getById(futureExecutionId);
				if (!latest || latest.nextRunAt > asOf) {
					return;
				}
				if (
					!latest.modelSelection &&
					deps.processGraphs &&
					deps.processActionRegistry &&
					deps.turnRecords
				) {
					const projected = await projectFutureExecutionModelState(
						{
							processes: deps.processes,
							projects: deps.projects,
							turnRecords: deps.turnRecords,
							processGraphs: deps.processGraphs,
							processActionRegistry: deps.processActionRegistry,
							policy: deps.processModelPolicy,
							availability: deps.modelStatusCache.snapshot(),
							now: () => operationTime,
						},
						latest,
					);
					if (projected) {
						const updated = deps.futureExecutions.update(latest.id, projected);
						if (updated) {
							latest = updated;
							effects.push(buildFutureExecutionUpdatedEffect(updated, "updated"));
						}
					}
				}
				if (latest.blockedReason) {
					outcome = { kind: "blocked" };
					return;
				}
				const policyState = evaluateStoredSelection(latest, operationTime);
				if (policyState?.blockedReason) {
					const nextRunAt =
						latest.scheduleKind === "cron"
							? computeNextCronRun(latest, operationTime)
							: latest.nextRunAt;
					applyTransition(
						planBlockFutureExecution(
							latest,
							policyState.blockedReason,
							policyState.selection,
							latest.scheduleKind === "cron" ? nextRunAt : undefined,
						),
						effects,
					);
					outcome =
						latest.scheduleKind === "cron" ? { kind: "occurrence_advanced" } : { kind: "blocked" };
					return;
				}
				const result =
					latest.kind === "launch"
						? await executeScheduledLaunch(deps, latest)
						: await executeScheduledAction(deps, latest);
				if (result.kind === "committed") {
					if (result.reactionError) {
						deps.logger?.error?.(
							{
								err: result.reactionError,
								futureExecutionId: latest.id,
								kind: latest.kind,
								scheduleKind: latest.scheduleKind,
								instanceId: latest.instanceId,
								processId: latest.processId,
								dispositionApplied: result.dispositionApplied,
							},
							"Future execution committed durable work but reported a post-commit error",
						);
					}
					outcome = result.reactionError
						? {
								kind: "durable_work_committed_with_reaction_error",
								error: result.reactionError.message,
							}
						: { kind: "durable_work_committed" };
					if (result.dispositionApplied) {
						if (latest.kind === "launch") {
							effects.push(
								buildFutureExecutionUpdatedEffect(
									latest,
									latest.scheduleKind === "cron" ? "updated" : "deleted",
								),
							);
						}
						return;
					}
					if (latest.scheduleKind === "cron") {
						const nextRunAt = computeNextCronRun(latest, new Date(latest.nextRunAt));
						applyTransition(planAdvanceFutureExecution(latest, nextRunAt), effects);
						return;
					}
					applyTransition(planConsumeFutureExecution(latest), effects);
					return;
				}
				deps.logger?.error?.(
					{
						err: result.error,
						futureExecutionId: latest.id,
						kind: latest.kind,
						scheduleKind: latest.scheduleKind,
						instanceId: latest.instanceId,
						processId: latest.processId,
						disposition: result.kind,
					},
					"Failed to execute future execution",
				);
				if (result.kind === "remove") {
					applyTransition(planConsumeFutureExecution(latest), effects);
					outcome = { kind: "terminal_invalid_removed" };
					return;
				}
				if (latest.scheduleKind === "cron") {
					try {
						const nextRunAt = computeNextCronRun(latest, operationTime);
						applyTransition(planAdvanceFutureExecution(latest, nextRunAt), effects);
					} catch (advanceError) {
						deps.logger?.error?.(
							{ err: advanceError, futureExecutionId: latest.id },
							"Failed to advance cron future execution after an execution error",
						);
					}
					outcome = { kind: "occurrence_advanced" };
					return;
				}
				deferOneTimeExecutionAfterFailure(latest, operationTime, effects);
				outcome = { kind: "retry_scheduled" };
			});
			const reaction = await runFutureExecutionPostCommitEffects(deps, effects);
			return reaction.ok || effects.length === 0
				? outcome
				: {
						kind: "durable_work_committed_with_reaction_error",
						error: reaction.message,
					};
		},
	};
}
