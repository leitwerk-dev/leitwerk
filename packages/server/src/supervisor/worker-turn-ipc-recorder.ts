import { isTurnFailureCode, isWorkerErrorClass } from "@leitwerk-dev/domain";
import type {
	WorkerTurnFailedPayload,
	WorkerTurnOutcomePayload,
} from "@leitwerk-dev/worker-protocol";
import type { RepositoryBundle } from "../db/repositories.js";
import type { ProcessEngine } from "../process-engine/types.js";
import type { createWorkerEventIngestor } from "./worker-event-ingestor.js";

export interface WorkerTurnIpcRecorderDeps extends Pick<RepositoryBundle, "processes"> {
	commands: ProcessEngine;
	eventIngestor: ReturnType<typeof createWorkerEventIngestor>;
}

export interface WorkerTurnIpcRecorderCallbacks {
	onTurnOutcomeRecorded?: (
		instanceId: string,
		turnId: string,
		outcome: string,
		params: Record<string, unknown>,
	) => void;
}

type TurnCorrelationCommandResult = Awaited<ReturnType<ProcessEngine["recordTurnOutcome"]>>;

function maybeNormalizeTurnCorrelationFailure(
	deps: Pick<WorkerTurnIpcRecorderDeps, "commands">,
	instanceId: string,
	result: TurnCorrelationCommandResult,
	eventType: "worker.turn_outcome" | "worker.turn_failed",
): void {
	if (result.ok) {
		return;
	}
	if (result.code !== "stale_turn_record" && result.code !== "missing_turn_record_id") {
		return;
	}
	void deps.commands
		.recordWorkerFailure(instanceId, {
			errorCode: result.code,
			message: `Worker emitted ${eventType} with invalid turn-record correlation: ${result.message}`,
			errorClass: "infrastructure",
		})
		.catch(() => {});
}

export function createWorkerTurnIpcRecorder(
	deps: WorkerTurnIpcRecorderDeps,
	callbacks: WorkerTurnIpcRecorderCallbacks,
) {
	return {
		recordTurnOutcome(instanceId: string, payload: WorkerTurnOutcomePayload): void {
			const { turnId, ...rest } = payload;
			if (deps.eventIngestor.getLiveTurnRecordId(instanceId) === rest.turnRecordId) {
				deps.eventIngestor.clearLiveTurnState(instanceId);
			}
			void deps.commands
				.recordTurnOutcome(instanceId, {
					instanceId,
					turnId,
					...rest,
				})
				.then((result) => {
					if (!result.ok) {
						maybeNormalizeTurnCorrelationFailure(deps, instanceId, result, "worker.turn_outcome");
						return;
					}
					callbacks.onTurnOutcomeRecorded?.(instanceId, turnId, rest.outcome, rest.params);
				})
				.catch(() => {});
		},
		recordTurnFailed(instanceId: string, payload: WorkerTurnFailedPayload): void {
			const { errorClass, failureCode, failureDetails, ...rest } = payload;
			if (errorClass !== undefined && !isWorkerErrorClass(errorClass)) {
				return;
			}
			const normalizedFailureCode =
				failureCode && isTurnFailureCode(failureCode) ? failureCode : undefined;
			if (deps.eventIngestor.getLiveTurnRecordId(instanceId) === rest.turnRecordId) {
				deps.eventIngestor.clearLiveTurnState(instanceId);
			}
			void deps.commands
				.recordTurnFailed(instanceId, {
					instanceId,
					errorClass,
					...(normalizedFailureCode ? { failureCode: normalizedFailureCode, failureDetails } : {}),
					...rest,
				})
				.then((result) => {
					maybeNormalizeTurnCorrelationFailure(deps, instanceId, result, "worker.turn_failed");
				})
				.catch(() => {});
		},
	};
}
