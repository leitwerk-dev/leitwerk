import type { Actor } from "@leitwerk-dev/domain";
import { generateId, now } from "../../db/repo-helpers.js";
import { buildRetryWrites } from "../../process-engine/writes/build-retry-writes.js";
import {
	applyProcessPatchField,
	createWrites,
	stampActorOnEvents,
} from "../../process-engine/writes/writes.js";
import { accept, reject } from "../decision.js";
import { defineOperation } from "../operation.js";

export interface RetryFailedTurnInput {
	instanceId: string;
	nextTurnModelProfileId?: string | null;
	providerOptions?: Readonly<Record<string, string>>;
	actor?: Actor;
}

export const RetryFailedTurn = defineOperation<"retry_failed_turn", RetryFailedTurnInput, void>({
	kind: "retry_failed_turn",
	label: "Retry failed turn",
	messages: {
		reconcileErrorMessage: "Process was reactivated, but the worker could not be started cleanly",
	},
	decide(ctx, input) {
		if (ctx.process.currentExecution?.kind === "server_turn") {
			const failed = ctx.deps.turnRecords.getById(ctx.process.currentExecution.id);
			if (!failed || failed.status !== "failed" || ctx.process.lifecycleStatus !== "error")
				return reject("retry_target_missing", "No failed server turn is available for retry");
			const id = generateId("trn");
			const writes = createWrites();
			writes.turnRecordWrites.push({
				kind: "create",
				input: {
					id,
					instanceId: failed.instanceId,
					turnId: failed.turnId,
					turnType: "server_automatic",
					status: "running",
					attemptNumber: failed.attemptNumber + 1,
					parentTurnRecordId: failed.id,
					startedAt: now(),
				},
			});
			applyProcessPatchField(writes, ctx.process, "currentExecution", { kind: "server_turn", id });
			applyProcessPatchField(writes, ctx.process, "lifecycleStatus", "active");
			return accept({ writes });
		}
		const currentStartId =
			ctx.process.currentExecution?.kind === "worker_start"
				? ctx.process.currentExecution.id
				: null;
		const currentStart = currentStartId ? ctx.deps.turnStarts.getById(currentStartId) : null;
		const failedRun =
			currentStart?.state.kind === "accepted"
				? ctx.deps.turnRecords.getById(currentStart.state.turnRecordId)
				: null;
		if (
			!currentStart ||
			currentStart.state.kind !== "accepted" ||
			!failedRun ||
			failedRun.status !== "failed"
		) {
			return reject("retry_target_missing", "No failed turn record is available for retry");
		}
		if (ctx.process.lifecycleStatus !== "error") {
			return reject("invalid_transition", "Process is not in an error state");
		}

		const writes = buildRetryWrites({
			processGraphs: ctx.deps.processGraphs,
			process: ctx.process,
			failedRun,
			acceptedStart: currentStart,
		});
		stampActorOnEvents(writes, input.actor, "retry_scheduled");
		return accept({
			writes,
			metadata:
				input.nextTurnModelProfileId !== undefined || input.providerOptions !== undefined
					? {
							...(input.nextTurnModelProfileId !== undefined
								? { nextTurnModelProfileId: input.nextTurnModelProfileId }
								: {}),
							...(input.providerOptions !== undefined
								? { providerOptions: input.providerOptions }
								: {}),
						}
					: undefined,
		});
	},
});
