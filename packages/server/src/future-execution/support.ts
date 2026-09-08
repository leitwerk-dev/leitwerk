import type { FutureExecution } from "@leitwerk-dev/domain";
import type { ProcessLaunchPlan } from "@leitwerk-dev/process-sdk";
import type { ParsedScheduleRequest } from "@leitwerk-dev/protocol";
import type { PostCommitEffect } from "../effects/post-commit-effect.js";
import {
	type PostCommitEffectResult,
	runPostCommitEffectList,
} from "../effects/post-commit-runner.js";
import type { ProcessOperationCoordinator } from "../process-operation-coordinator.js";
import type { ProcessTitleGenerator } from "../process-title-generator.js";
import type { Broadcaster } from "../ws/broadcast.js";

export function resolveStoredScheduleRequest(
	execution: Pick<FutureExecution, "scheduleKind" | "nextRunAt" | "cronExpression">,
):
	| { ok: true; value: ParsedScheduleRequest }
	| { ok: false; issue: { code: string; message: string } } {
	if (execution.scheduleKind === "cron") {
		return execution.cronExpression
			? { ok: true, value: { mode: "cron", cronExpression: execution.cronExpression } }
			: {
					ok: false,
					issue: {
						code: "invalid_schedule",
						message: "Scheduled execution is missing its cron expression",
					},
				};
	}
	return { ok: true, value: { mode: "once", runAt: execution.nextRunAt } };
}

export function buildFutureExecutionUpdatedEffect(
	futureExecution: Pick<FutureExecution, "id" | "kind" | "instanceId">,
	operation: "created" | "updated" | "deleted",
): PostCommitEffect {
	return {
		kind: "future_execution_updated",
		futureExecution: {
			id: futureExecution.id,
			kind: futureExecution.kind,
			instanceId: futureExecution.instanceId ?? null,
		},
		operation,
	};
}

export function buildQueueFutureExecutionTitleEffect(
	futureExecution: Pick<FutureExecution, "id" | "payloadJson">,
	launchPlan: ProcessLaunchPlan,
): PostCommitEffect {
	return {
		kind: "queue_future_execution_title",
		futureExecutionId: futureExecution.id,
		launchPlan,
		expectedPayloadJson: futureExecution.payloadJson,
	};
}

export async function runFutureExecutionPostCommitEffects(
	deps: { broadcaster: Broadcaster; processTitles?: ProcessTitleGenerator },
	effects: readonly PostCommitEffect[],
): Promise<PostCommitEffectResult> {
	if (effects.length === 0) return { ok: true };
	return runPostCommitEffectList(
		{
			broadcaster: deps.broadcaster,
			getSupervisor: () => undefined,
			processTitles: deps.processTitles,
		},
		effects,
		{},
		{ stage: "post_commit", operationKind: "future_execution" },
		{ reportBestEffortFailures: true },
	);
}

export function futureExecutionLockKey(futureExecutionId: string): string {
	return `future_execution:${futureExecutionId}`;
}

export function runFutureExecutionExclusive<T>(
	processOperations: ProcessOperationCoordinator,
	futureExecutionId: string,
	operation: () => T | Promise<T>,
): Promise<T> {
	return processOperations.runExclusive(futureExecutionLockKey(futureExecutionId), operation);
}
