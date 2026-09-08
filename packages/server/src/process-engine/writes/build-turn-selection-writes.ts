import {
	lifecycleStatusForSelectedTurnType,
	type ProcessInstance,
	type ProcessLifecycleStatus,
	type TransitionTrigger,
	type TurnId,
} from "@leitwerk-dev/domain";
import { generateId } from "../../db/repo-helpers.js";
import { tryTransition } from "../../domain-logic/process-state-machine.js";
import { getProcessTurnGraph, type ProcessGraphRegistry } from "../../process-graph.js";
import { selectedTurnRequiresWorker } from "../turn-worker-requirement.js";
import {
	applyProcessPatchField,
	createWrites,
	type WorkerIntent,
	type WriteBuildFailure,
	type WriteBuildResult,
} from "./writes.js";

export interface TurnSelectionWritesInput {
	fromTurnId?: TurnId | null;
	toTurnId: TurnId | null;
	trigger?: TransitionTrigger | string;
	lifecycleStatus?: ProcessLifecycleStatus;
	workerIntent?: WorkerIntent;
	state?: unknown;
}

function validateTurnSelectionWorkerIntent(
	processGraphs: ProcessGraphRegistry,
	process: Pick<ProcessInstance, "processId">,
	targetTurnId: TurnId | null,
	targetLifecycleStatus: ProcessLifecycleStatus,
	workerIntent: WorkerIntent | undefined,
): WriteBuildFailure | null {
	switch (workerIntent?.kind) {
		case "restart_worker":
			if (
				!selectedTurnRequiresWorker(processGraphs, {
					processId: process.processId,
					selectedTurnId: targetTurnId,
					lifecycleStatus: targetLifecycleStatus,
				})
			) {
				return {
					ok: false,
					code: "invalid_transition",
					message: "restart_worker requires a target selected turn that uses a worker",
				};
			}
			break;
		default:
			break;
	}

	return null;
}

export function deriveLifecycleStatusForSelectedTurn(
	processGraphs: ProcessGraphRegistry,
	processId: string,
	turnId: TurnId,
): ProcessLifecycleStatus {
	const turn = getProcessTurnGraph(processGraphs, processId, turnId);
	return turn ? lifecycleStatusForSelectedTurnType(turn.turnType) : "active";
}

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

	const workerIntentValidation = validateTurnSelectionWorkerIntent(
		processGraphs,
		process,
		input.toTurnId,
		targetLifecycleStatus,
		input.workerIntent,
	);
	if (workerIntentValidation) {
		return workerIntentValidation;
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
			const startId = generateId("tsr");
			writes.turnStartWrites.push({
				kind: "create",
				input: {
					id: startId,
					instanceId: process.id,
					turnId: input.toTurnId,
					turnType: target.turnType,
					proposedTurnRecordId: generateId("trn"),
					startKind: "selected_turn",
					recoveryTurnRecordId: null,
					continuation: null,
					state:
						target.turnType === "automatic"
							? { kind: "starting", start: { kind: "automatic" } }
							: {
									kind: "preparation_failed",
									requestedModelProfileId: process.selectedTurnModelProfileId ?? null,
									providerOptions: {},
									code: "model_required",
									safeSummary: "LLM start requires model preflight",
								},
				},
			});
			applyProcessPatchField(writes, process, "currentExecution", {
				kind: "worker_start",
				id: startId,
			});
			if (target.turnType === "llm")
				applyProcessPatchField(writes, process, "lifecycleStatus", "error");
		}
	} else if (
		input.toTurnId === null ||
		targetLifecycleStatus === "waiting" ||
		targetLifecycleStatus === "completed" ||
		targetLifecycleStatus === "aborted"
	) {
		applyProcessPatchField(writes, process, "currentExecution", null);
	}

	const selectedTurnChanged = process.selectedTurnId !== input.toTurnId;
	if (selectedTurnChanged) {
		writes.events.push({
			instanceId: process.id,
			eventType: "turn_selected",
			data: {
				fromTurnId: process.selectedTurnId,
				toTurnId: input.toTurnId,
				fromLifecycleStatus: process.lifecycleStatus,
				toLifecycleStatus: targetLifecycleStatus,
				...(input.trigger !== undefined ? { trigger: input.trigger } : {}),
			},
		});
		writes.broadcasts.push({
			type: "process.event",
			payload: {
				eventType: "turn_selected",
				level: "info",
				message:
					input.toTurnId === null
						? `Lifecycle moved to ${targetLifecycleStatus}`
						: `Selected turn ${input.toTurnId}`,
			},
			instanceId: process.id,
		});
	}

	return writes;
}
