import {
	lifecycleStatusForSelectedTurnType,
	type ProcessInstance,
	type ProcessLifecycleStatus,
	type TransitionTrigger,
	type TurnId,
} from "@leitwerk-dev/domain";
import { tryTransition } from "../../domain-logic/process-state-machine.js";
import { getProcessTurnGraph, type ProcessGraphRegistry } from "../../process-graph.js";
import { selectedTurnRequiresWorker } from "../turn-worker-requirement.js";
import { reserveSelectedTurnStart } from "./reserve-selected-turn-start.js";
import {
	appendProcessEvent,
	applyProcessPatchField,
	createWrites,
	type WorkerIntent,
	type WriteBuildResult,
} from "./writes.js";

/** @internal */
export interface TurnSelectionWritesInput {
	/** @internal */
	fromTurnId?: TurnId | null;
	/** @internal */
	toTurnId: TurnId | null;
	/** @internal */
	trigger?: TransitionTrigger | string;
	/** @internal */
	lifecycleStatus?: ProcessLifecycleStatus;
	/** @internal */
	workerIntent?: WorkerIntent;
	/** @internal */
	state?: unknown;
}

function deriveLifecycleStatusForSelectedTurn(
	processGraphs: ProcessGraphRegistry,
	processId: string,
	turnId: TurnId,
): ProcessLifecycleStatus {
	const turn = getProcessTurnGraph(processGraphs, processId, turnId);
	return turn ? lifecycleStatusForSelectedTurnType(turn.turnType) : "active";
}

/** @internal */
export function buildTurnSelectionWrites(
	processGraphs: ProcessGraphRegistry,
	process: ProcessInstance,
	input: TurnSelectionWritesInput,
): WriteBuildResult {
	if (input.fromTurnId !== undefined && input.fromTurnId !== process.selectedTurnId) {
		return {
			ok: false,
			code: "stale_turn",
			message: `Process selectedTurnId is '${process.selectedTurnId}', not '${input.fromTurnId}'`,
		};
	}

	const targetLifecycleStatus =
		input.lifecycleStatus ??
		(input.toTurnId === null
			? process.lifecycleStatus
			: deriveLifecycleStatusForSelectedTurn(processGraphs, process.processId, input.toTurnId));

	if (
		input.workerIntent?.kind === "restart_worker" &&
		!selectedTurnRequiresWorker(processGraphs, {
			processId: process.processId,
			selectedTurnId: input.toTurnId,
			lifecycleStatus: targetLifecycleStatus,
		})
	) {
		return {
			ok: false,
			code: "invalid_transition",
			message: "restart_worker requires a target selected turn that uses a worker",
		};
	}

	if (input.toTurnId === null) {
		if (
			targetLifecycleStatus !== "completed" &&
			targetLifecycleStatus !== "aborted" &&
			targetLifecycleStatus !== "discovered"
		) {
			return {
				ok: false,
				code: "invalid_transition",
				message:
					"Clearing selectedTurnId requires lifecycleStatus discovered, completed, or aborted",
			};
		}
	} else if (input.toTurnId !== process.selectedTurnId) {
		const transition = tryTransition(
			processGraphs,
			process.processId,
			process.selectedTurnId,
			input.trigger,
			input.toTurnId,
			process.lifecycleStatus,
		);
		if (!transition.ok) {
			return {
				ok: false,
				code: transition.code,
				message: transition.message,
			};
		}
	}

	const writes = createWrites({ workerIntent: input.workerIntent ?? { kind: "reconcile" } });
	applyProcessPatchField(writes, process, "selectedTurnId", input.toTurnId);
	applyProcessPatchField(writes, process, "lifecycleStatus", targetLifecycleStatus);
	// A worker-owned turn reserves its future record before a worker is allowed
	// to run. This deliberately creates no attempt/turn record.
	if (input.toTurnId && targetLifecycleStatus === "active") {
		const target = getProcessTurnGraph(processGraphs, process.processId, input.toTurnId);
		if (target?.turnType === "llm" || target?.turnType === "automatic") {
			reserveSelectedTurnStart(writes, process, input.toTurnId, target.turnType);
		}
	} else if (
		input.toTurnId === null ||
		targetLifecycleStatus === "waiting" ||
		targetLifecycleStatus === "completed" ||
		targetLifecycleStatus === "aborted"
	) {
		applyProcessPatchField(writes, process, "currentExecution", null);
	}

	if (process.selectedTurnId !== input.toTurnId) {
		appendProcessEvent(writes, process, {
			eventType: "turn_selected",
			level: "info",
			message:
				input.toTurnId === null
					? `Lifecycle moved to ${targetLifecycleStatus}`
					: `Selected turn ${input.toTurnId}`,
			data: {
				fromTurnId: process.selectedTurnId,
				toTurnId: input.toTurnId,
				fromLifecycleStatus: process.lifecycleStatus,
				toLifecycleStatus: targetLifecycleStatus,
				...(input.trigger !== undefined ? { trigger: input.trigger } : {}),
			},
		});
	}

	return writes;
}
