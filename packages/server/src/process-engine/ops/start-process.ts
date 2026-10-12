import type { Actor, TurnId } from "@leitwerk-dev/domain";
import type { WaitingProcessRestart } from "@leitwerk-dev/process-sdk";
import { buildTurnSelectionWrites } from "../../process-engine/writes/build-turn-selection-writes.js";
import { accept, noWrites, reject } from "../decision.js";
import { defineOperation } from "../operation.js";
import { applyProcessPatchField, stampActorOnEvents } from "../writes/writes.js";

export interface StartProcessInput {
	instanceId: string;
	startTurnId: TurnId;
	actor?: Actor;
	onlyIfUnstarted?: boolean;
	restart?: WaitingProcessRestart;
}

export const StartProcess = defineOperation<"start_process", StartProcessInput, void>({
	kind: "start_process",
	label: "Start process",
	decide(ctx, input) {
		const restart = input.restart;
		if (
			restart &&
			(ctx.process.lifecycleStatus !== "waiting" ||
				ctx.process.currentExecution !== null ||
				ctx.process.selectedTurnId !== restart.expected.turnId ||
				ctx.process.paramsJson !== restart.expected.paramsJson ||
				ctx.process.stateJson !== restart.expected.stateJson)
		) {
			return reject("restart_superseded", "The captured waiting process has changed");
		}
		if (restart && ctx.deps.isNewTurnBlocked?.(input.instanceId)) {
			return reject("session_transfer_in_progress", "A local session transfer is in progress");
		}
		const project = restart?.project
			? ctx.deps.projects.getByInstanceAndKey(input.instanceId, restart.project.key)
			: null;
		if (
			restart?.project &&
			(!project || project.baseBranch !== restart.project.expectedBaseBranch)
		) {
			return reject("restart_superseded", "The captured process repository has changed");
		}
		if (restart) JSON.parse(restart.stateJson);
		if (
			input.onlyIfUnstarted &&
			(ctx.process.lifecycleStatus !== "discovered" ||
				ctx.process.selectedTurnId !== null ||
				ctx.process.currentExecution !== null)
		) {
			return noWrites();
		}
		const writes = buildTurnSelectionWrites(ctx.deps.processGraphs, ctx.process, {
			fromTurnId: ctx.process.selectedTurnId,
			toTurnId: input.startTurnId,
			trigger: "start",
		});
		if ("ok" in writes) return writes;
		if (restart) {
			applyProcessPatchField(writes, ctx.process, "stateJson", restart.stateJson);
			if (project && restart.project) {
				writes.projectWrite = { id: project.id, input: { baseBranch: restart.project.baseBranch } };
			}
		}
		stampActorOnEvents(writes, input.actor, "turn_selected");
		return accept({ writes });
	},
});
