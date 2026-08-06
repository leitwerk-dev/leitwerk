import type { FutureExecution, ProcessInput } from "@leitwerk-dev/domain";

export type ActionSource = "ui" | "external" | "scheduled";

export interface ScheduledActionLockFailure {
	error: string;
	code: "scheduled_action_missing" | "action_locked_by_schedule";
}

export function queuedInputsRequireScheduledActionLockBypass(
	queuedInputs: Pick<ProcessInput, "source">[],
): boolean {
	return queuedInputs.some((input) => input.source !== "system");
}

export function isQueuedInputBlockedByScheduledAction(input: {
	scheduledAction: Pick<FutureExecution, "id"> | null;
	queuedInputs: Pick<ProcessInput, "source">[];
}): boolean {
	return (
		input.scheduledAction !== null &&
		queuedInputsRequireScheduledActionLockBypass(input.queuedInputs)
	);
}

export function evaluateScheduledActionLock(input: {
	scheduledAction: Pick<FutureExecution, "id"> | null;
	actionSource: ActionSource;
	scheduledExecutionId?: string;
}): { ok: true } | ({ ok: false } & ScheduledActionLockFailure) {
	const targetsCurrentScheduledAction =
		typeof input.scheduledExecutionId === "string" &&
		input.scheduledAction?.id === input.scheduledExecutionId;

	if (input.scheduledAction) {
		if (input.actionSource === "scheduled") {
			if (!targetsCurrentScheduledAction) {
				return {
					ok: false,
					error: "The scheduled action is no longer available",
					code: "scheduled_action_missing",
				};
			}
		} else if (!targetsCurrentScheduledAction) {
			return {
				ok: false,
				error: "This process is locked until the scheduled action runs or is canceled",
				code: "action_locked_by_schedule",
			};
		}
	}

	if (
		(input.actionSource === "scheduled" || input.scheduledExecutionId) &&
		!input.scheduledAction
	) {
		return {
			ok: false,
			error: "The scheduled action was canceled before it could run",
			code: "scheduled_action_missing",
		};
	}

	return { ok: true };
}
