import type { Actor, ProcessInput } from "@leitwerk-dev/domain";
import { isQueuedInputBlockedByScheduledAction } from "../../domain-logic/scheduled-action-lock.js";
import {
	type QueuedProcessInput,
	validateQueuedProcessInput,
} from "../../process-input-dispatch.js";
import { accept, reject } from "../decision.js";
import { defineOperation } from "../operation.js";

export interface QueueInputsInput {
	instanceId: string;
	queued: QueuedProcessInput[];
	opts?: { dispatchErrorMessage?: string; actor?: Actor };
}

export const QueueInputs = defineOperation<"queue_inputs", QueueInputsInput, ProcessInput[]>({
	kind: "queue_inputs",
	label: "Queue inputs",
	messages: (input) => ({
		dispatchErrorMessage:
			input.opts?.dispatchErrorMessage ?? "Failed to deliver queued inputs to the worker",
	}),
	decide(ctx, input) {
		const scheduledAction = ctx.deps.futureExecutions.getScheduledActionByInstance(
			input.instanceId,
		);
		if (isQueuedInputBlockedByScheduledAction({ scheduledAction, queuedInputs: input.queued })) {
			return reject(
				"scheduled_action_locked",
				"This process is locked until the scheduled action runs or is canceled",
			);
		}
		for (const queuedInput of input.queued) {
			const validationError = validateQueuedProcessInput(queuedInput);
			if (validationError) {
				return reject("invalid_process_input", validationError);
			}
		}
		// Stamp the resolved actor onto inputs that did not already carry one so the
		// durable queue records who steered/commented.
		const actor = input.opts?.actor;
		const queuedWithActor = actor
			? input.queued.map((queuedInput) =>
					queuedInput.actor ? queuedInput : { ...queuedInput, actor },
				)
			: input.queued;
		return accept<ProcessInput[]>({
			writes: { queuedInputs: queuedWithActor },
			data: [],
			deriveData: (record) => record.persistedInputs,
		});
	},
});
