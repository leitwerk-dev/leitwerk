import type { ProcessInstance } from "@leitwerk-dev/domain";
import type { ServerTransitionRequest } from "@leitwerk-dev/process-sdk";
import type { ProcessGraphRegistry } from "../../process-graph.js";
import { selectedTurnRequiresWorker } from "../turn-worker-requirement.js";
import { buildTurnSelectionWrites } from "./build-turn-selection-writes.js";
import {
	applyProcessPatchField,
	createWrites,
	isWriteBuildFailure,
	mergeWrites,
	type WorkerIntent,
	type WriteBuildResult,
} from "./writes.js";

export function buildServerTransitionWrites<TState = unknown>(
	processGraphs: ProcessGraphRegistry,
	process: ProcessInstance,
	request: ServerTransitionRequest<TState>,
): WriteBuildResult {
	const stateWrites = createWrites();

	if (request.state !== undefined) {
		const nextStateJson = JSON.stringify(request.state);
		applyProcessPatchField(stateWrites, process, "stateJson", nextStateJson);
	}

	const targetTurnId = request.turnId;
	const runtime = request.effect?.runtime;
	const workerIntent: WorkerIntent | undefined =
		runtime === "reconcile" || runtime === "restart_worker" ? { kind: runtime } : undefined;

	if (targetTurnId !== undefined) {
		const selectionWrites = buildTurnSelectionWrites(processGraphs, process, {
			fromTurnId: process.selectedTurnId,
			toTurnId: targetTurnId,
			trigger: request.trigger,
			lifecycleStatus: request.lifecycleStatus,
			workerIntent,
			state: request.state,
		});
		if (isWriteBuildFailure(selectionWrites)) {
			return selectionWrites;
		}
		return mergeWrites(selectionWrites, stateWrites);
	}

	if (
		runtime === "restart_worker" &&
		!selectedTurnRequiresWorker(processGraphs, {
			processId: process.processId,
			selectedTurnId: process.selectedTurnId,
			lifecycleStatus: request.lifecycleStatus ?? process.lifecycleStatus,
		})
	) {
		return {
			ok: false,
			code: "invalid_transition",
			message: "restart_worker requires a target selected turn that uses a worker",
		};
	}
	if (workerIntent) {
		stateWrites.workerIntent = workerIntent;
	}

	if (request.lifecycleStatus !== undefined) {
		applyProcessPatchField(stateWrites, process, "lifecycleStatus", request.lifecycleStatus);
	}

	return stateWrites;
}
