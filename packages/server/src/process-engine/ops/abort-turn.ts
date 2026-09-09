import { type Actor, SYSTEM_ACTOR } from "@leitwerk-dev/domain";
import { resolveCurrentExecutionTurnRecordId } from "../../process-execution.js";
import { accept, reject } from "../decision.js";
import { defineOperation } from "../operation.js";
import { appendProcessEvent, createWrites } from "../writes/writes.js";

export interface AbortTurnInput {
	instanceId: string;
	reason: string;
	actor?: Actor;
}

export const AbortTurn = defineOperation<"abort_turn", AbortTurnInput, void>({
	kind: "abort_turn",
	label: "Abort running turn",
	async decide(ctx, input) {
		// Validate supervisor availability before lifecycle/turn state so the failure
		// precedence matches the pre-engine route contract (supervisor 503 outranks
		// invalid-state 400 when both conditions hold).
		const supervisor = ctx.deps.getSupervisor();
		if (!supervisor) {
			return reject("worker_supervisor_unavailable", "Worker supervisor is not available");
		}
		if (ctx.process.lifecycleStatus !== "active") {
			return reject(
				"invalid_transition",
				"Only an active process with a running turn can be stopped",
			);
		}
		const activeTurnRecordId = resolveCurrentExecutionTurnRecordId(
			ctx.process,
			ctx.deps.turnStarts,
		);
		const currentTurnRecord = activeTurnRecordId
			? ctx.deps.turnRecords.getById(activeTurnRecordId)
			: null;
		if (currentTurnRecord?.status !== "running" || currentTurnRecord.turnType !== "llm") {
			return reject("invalid_transition", "This process has no running LLM turn to stop");
		}
		if (!supervisor.getWorker(ctx.process.id)) {
			return reject("worker_unavailable", "No active worker is available to stop this turn");
		}

		const actor = input.actor ?? SYSTEM_ACTOR;
		const writes = createWrites({ workerIntent: { kind: "abort_turn", reason: input.reason } });
		appendProcessEvent(writes, ctx.process, {
			eventType: "turn_abort_requested",
			level: "info",
			message: "Turn abort requested",
			data: {
				turnRecordId: currentTurnRecord.id,
				turnId: currentTurnRecord.turnId,
				reason: input.reason,
				actor,
			},
		});
		return accept({ writes });
	},
});
