import type { TurnFailedPayload } from "@leitwerk-dev/domain";
import { validateTurnFailedCorrelation } from "../../domain-logic/turn-record-guards.js";
import { buildTurnFailedWrites } from "../../process-engine/writes/build-turn-failed-writes.js";
import { accept, reject } from "../decision.js";
import { defineOperation } from "../operation.js";

export interface TurnFailedInput {
	instanceId: string;
	payload: TurnFailedPayload;
	onRecorded?: () => void;
}

export const TurnFailed = defineOperation<"turn_failed", TurnFailedInput, void>({
	kind: "turn_failed",
	label: "Turn failed",
	afterRecord(input) {
		input.onRecorded?.();
	},
	decide(ctx, input) {
		const expected =
			ctx.process.currentExecution?.kind === "worker_start"
				? (() => {
						const state = ctx.deps.turnStarts.getById(ctx.process.currentExecution.id)?.state;
						return state?.kind === "accepted" ? state.turnRecordId : null;
					})()
				: ctx.process.currentExecution?.kind === "server_turn"
					? ctx.process.currentExecution.id
					: null;
		const correlationError = validateTurnFailedCorrelation(ctx.process, input.payload, expected);
		if (correlationError) {
			return reject(correlationError.code, correlationError.message);
		}
		const existingTurnRecord = ctx.deps.turnRecords.getById(input.payload.turnRecordId);
		if (!existingTurnRecord) {
			return reject(
				"stale_turn_record",
				"Accepted worker turn record is missing and cannot be failed",
			);
		}
		return accept({
			writes: buildTurnFailedWrites({
				process: ctx.process,
				payload: input.payload,
				existingTurnRecord,
			}),
		});
	},
});
