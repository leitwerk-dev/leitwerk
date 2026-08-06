import type { Actor, TurnId } from "@leitwerk-dev/domain";
import { buildTurnSelectionWrites } from "../../process-engine/writes/build-turn-selection-writes.js";
import { accept } from "../decision.js";
import { defineOperation } from "../operation.js";
import { stampActorOnEvents } from "../writes/writes.js";

export interface StartProcessInput {
	instanceId: string;
	startTurnId: TurnId;
	actor?: Actor;
}

export const StartProcess = defineOperation<"start_process", StartProcessInput, void>({
	kind: "start_process",
	label: "Start process",
	decide(ctx, input) {
		const writes = buildTurnSelectionWrites(ctx.deps.processGraphs, ctx.process, {
			fromTurnId: ctx.process.selectedTurnId,
			toTurnId: input.startTurnId,
			trigger: "start",
		});
		if ("ok" in writes) return writes;
		stampActorOnEvents(writes, input.actor, "turn_selected");
		return accept({ writes });
	},
});
