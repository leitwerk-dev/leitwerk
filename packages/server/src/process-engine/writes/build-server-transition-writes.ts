import type { ProcessInstance, ProcessLifecycleStatus } from "@leitwerk-dev/domain";
import type { ServerTransitionRequest, ServerTransitionRuntime } from "@leitwerk-dev/process-sdk";
import type { ProcessGraphRegistry } from "../../process-graph.js";
import { selectedTurnRequiresWorker } from "../turn-worker-requirement.js";
import {
	buildTurnSelectionWrites,
	deriveLifecycleStatusForSelectedTurn,
	validateReviewSubjectTurnInvariant,
} from "./build-turn-selection-writes.js";
import {
	applyProcessPatchField,
	createWrites,
	isWriteBuildFailure,
	mergeWrites,
	type WorkerIntent,
	type WriteBuildFailure,
	type WriteBuildResult,
} from "./writes.js";

function invalidTransition(message: string, _data?: Record<string, unknown>): WriteBuildFailure {
	return { ok: false, code: "invalid_transition", message };
}

function resolveTargetLifecycleStatus(
	processGraphs: ProcessGraphRegistry,
	process: ProcessInstance,
	request: ServerTransitionRequest,
	targetTurnId: string | null | undefined,
): ProcessLifecycleStatus {
	if (request.lifecycleStatus !== undefined) {
		return request.lifecycleStatus;
	}
	if (targetTurnId === undefined || targetTurnId === null) {
		return process.lifecycleStatus;
	}
	return deriveLifecycleStatusForSelectedTurn(processGraphs, process.processId, targetTurnId);
}

function resolveRuntimeWorkerIntent(
	processGraphs: ProcessGraphRegistry,
	process: ProcessInstance,
	runtime: ServerTransitionRuntime | undefined,
	targetTurnId: string | null | undefined,
	targetLifecycleStatus: ProcessLifecycleStatus,
	turnChanged: boolean,
): WorkerIntent | undefined | WriteBuildFailure {
	if (!runtime) {
		return turnChanged ? { kind: "reconcile" } : undefined;
	}

	switch (runtime) {
		case "reconcile":
			return { kind: "reconcile" };
		case "restart_worker":
			if (
				!selectedTurnRequiresWorker(processGraphs, {
					processId: process.processId,
					selectedTurnId: targetTurnId ?? null,
					lifecycleStatus: targetLifecycleStatus,
				})
			) {
				return invalidTransition(
					"restart_worker requires a target selected turn that uses a worker",
					{ targetTurnId, targetLifecycleStatus },
				);
			}
			return { kind: "restart_worker" };
		default:
			return undefined;
	}
}

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
	const targetLifecycleStatus = resolveTargetLifecycleStatus(
		processGraphs,
		process,
		request,
		targetTurnId,
	);
	const turnChanged = targetTurnId !== undefined && targetTurnId !== process.selectedTurnId;
	const effectiveTargetTurnId = targetTurnId === undefined ? process.selectedTurnId : targetTurnId;
	const effectiveTargetLifecycleStatus =
		targetTurnId === undefined
			? (request.lifecycleStatus ?? process.lifecycleStatus)
			: targetLifecycleStatus;

	if (effectiveTargetTurnId !== undefined) {
		const reviewSubjectValidation = validateReviewSubjectTurnInvariant(
			processGraphs,
			process,
			effectiveTargetTurnId,
			request.state,
		);
		if (reviewSubjectValidation) {
			return reviewSubjectValidation;
		}
	}

	const resolvedWorkerIntent = resolveRuntimeWorkerIntent(
		processGraphs,
		process,
		request.effect?.runtime,
		effectiveTargetTurnId,
		effectiveTargetLifecycleStatus,
		turnChanged,
	);
	if (resolvedWorkerIntent && "ok" in resolvedWorkerIntent) {
		return resolvedWorkerIntent;
	}

	if (targetTurnId !== undefined && turnChanged) {
		const selectionWrites = buildTurnSelectionWrites(processGraphs, process, {
			fromTurnId: process.selectedTurnId,
			toTurnId: targetTurnId,
			trigger: request.trigger,
			lifecycleStatus: request.lifecycleStatus,
			workerIntent: resolvedWorkerIntent,
			state: request.state,
		});
		if (isWriteBuildFailure(selectionWrites)) {
			return selectionWrites;
		}
		return mergeWrites(selectionWrites, stateWrites);
	}

	if (resolvedWorkerIntent) {
		stateWrites.workerIntent = resolvedWorkerIntent;
	}

	if (request.lifecycleStatus !== undefined) {
		applyProcessPatchField(stateWrites, process, "lifecycleStatus", request.lifecycleStatus);
	}

	return stateWrites;
}
