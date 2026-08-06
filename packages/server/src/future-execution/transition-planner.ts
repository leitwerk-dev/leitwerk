import type {
	DurableModelSelection,
	FutureExecution,
	FutureExecutionBlockReason,
} from "@leitwerk-dev/domain";
import type { RepositoryBundle } from "../db/repositories.js";

export type FutureExecutionTransitionPlan =
	| {
			kind: "consume";
			futureExecutionId: string;
			expectedKind: FutureExecution["kind"];
			expectedNextRunAt: string;
	  }
	| {
			kind: "advance";
			futureExecutionId: string;
			expectedKind: FutureExecution["kind"];
			expectedNextRunAt: string;
			nextRunAt: string;
	  }
	| {
			kind: "block";
			futureExecutionId: string;
			expectedKind: FutureExecution["kind"];
			expectedNextRunAt: string;
			blockedReason: FutureExecutionBlockReason;
			modelSelection: DurableModelSelection | null;
			nextRunAt?: string;
	  }
	| {
			kind: "retry";
			futureExecutionId: string;
			expectedKind: FutureExecution["kind"];
			expectedNextRunAt: string;
			nextRunAt: string;
	  }
	| {
			kind: "cancel_action";
			futureExecutionId: string;
			expectedInstanceId: string;
	  };

export type FutureExecutionTransitionApplication =
	| { kind: "applied"; previous: FutureExecution; execution: FutureExecution | null }
	| { kind: "stale" };

function expectedOccurrence(
	execution: FutureExecution,
	plan: Exclude<FutureExecutionTransitionPlan, { kind: "cancel_action" }>,
): boolean {
	return (
		execution.id === plan.futureExecutionId &&
		execution.kind === plan.expectedKind &&
		execution.nextRunAt === plan.expectedNextRunAt
	);
}

function occurrencePlan(
	execution: FutureExecution,
): Pick<
	Exclude<FutureExecutionTransitionPlan, { kind: "cancel_action" }>,
	"futureExecutionId" | "expectedKind" | "expectedNextRunAt"
> {
	return {
		futureExecutionId: execution.id,
		expectedKind: execution.kind,
		expectedNextRunAt: execution.nextRunAt,
	};
}

export function planConsumeFutureExecution(
	execution: FutureExecution,
): FutureExecutionTransitionPlan {
	return {
		kind: "consume",
		...occurrencePlan(execution),
	};
}

export function planAdvanceFutureExecution(
	execution: FutureExecution,
	nextRunAt: string,
): FutureExecutionTransitionPlan {
	return {
		kind: "advance",
		...occurrencePlan(execution),
		nextRunAt,
	};
}

export function planBlockFutureExecution(
	execution: FutureExecution,
	blockedReason: FutureExecutionBlockReason,
	modelSelection: DurableModelSelection | null,
	nextRunAt?: string,
): FutureExecutionTransitionPlan {
	return {
		kind: "block",
		...occurrencePlan(execution),
		blockedReason,
		modelSelection,
		...(nextRunAt ? { nextRunAt } : {}),
	};
}

export function planRetryFutureExecution(
	execution: FutureExecution,
	nextRunAt: string,
): FutureExecutionTransitionPlan {
	return {
		kind: "retry",
		...occurrencePlan(execution),
		nextRunAt,
	};
}

export function planCancelScheduledAction(
	execution: FutureExecution,
	instanceId: string,
): FutureExecutionTransitionPlan | null {
	if (execution.kind !== "action" || execution.instanceId !== instanceId) return null;
	return {
		kind: "cancel_action",
		futureExecutionId: execution.id,
		expectedInstanceId: instanceId,
	};
}

export function applyFutureExecutionTransitionPlan(
	futureExecutions: RepositoryBundle["futureExecutions"],
	plan: FutureExecutionTransitionPlan,
): FutureExecutionTransitionApplication {
	const current = futureExecutions.getById(plan.futureExecutionId);
	if (!current) return { kind: "stale" };
	const deleteCurrent = (): FutureExecutionTransitionApplication =>
		futureExecutions.delete(current.id)
			? { kind: "applied", previous: current, execution: null }
			: { kind: "stale" };
	if (plan.kind === "cancel_action") {
		if (current.kind !== "action" || current.instanceId !== plan.expectedInstanceId) {
			return { kind: "stale" };
		}
		return deleteCurrent();
	}
	if (!expectedOccurrence(current, plan)) return { kind: "stale" };
	if (plan.kind === "consume") {
		return deleteCurrent();
	}
	const execution = futureExecutions.update(current.id, {
		...(plan.kind === "block"
			? { blockedReason: plan.blockedReason, modelSelection: plan.modelSelection }
			: {}),
		...(plan.nextRunAt ? { nextRunAt: plan.nextRunAt } : {}),
	});
	return execution ? { kind: "applied", previous: current, execution } : { kind: "stale" };
}

export function applyRequiredFutureExecutionTransitionPlan(
	futureExecutions: RepositoryBundle["futureExecutions"],
	plan: FutureExecutionTransitionPlan,
): Extract<FutureExecutionTransitionApplication, { kind: "applied" }> {
	const result = applyFutureExecutionTransitionPlan(futureExecutions, plan);
	if (result.kind === "stale") {
		throw new Error("Future execution changed before atomic commit");
	}
	return result;
}
