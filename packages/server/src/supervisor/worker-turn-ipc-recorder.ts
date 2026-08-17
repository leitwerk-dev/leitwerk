import { isTurnFailureCode, isWorkerErrorClass } from "@leitwerk-dev/domain";
import type {
	WorkerTurnFailedPayload,
	WorkerTurnOutcomePayload,
} from "@leitwerk-dev/worker-protocol";
import type { RepositoryBundle } from "../db/repositories.js";
import type { ProcessEngine } from "../process-engine/types.js";
import type { createWorkerEventIngestor } from "./worker-event-ingestor.js";

export interface WorkerTurnIpcRecorderDeps
	extends Pick<RepositoryBundle, "processes" | "turnRecords"> {
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
	onTurnTerminalRecorded?: (instanceId: string, workerId: string, turnRecordId: string) => void;
	onTurnTerminalRecordingFailed?: (input: {
		instanceId: string;
		workerId: string;
		turnRecordId: string;
		terminalType: "outcome" | "failure";
		code: string;
		message: string;
	}) => void;
}

type TurnCorrelationCommandResult = Awaited<ReturnType<ProcessEngine["recordTurnOutcome"]>>;

type TerminalType = "outcome" | "failure";

function terminalWasAlreadyRecorded(
	deps: Pick<WorkerTurnIpcRecorderDeps, "turnRecords">,
	turnRecordId: string,
	terminalType: TerminalType,
): boolean {
	const record = deps.turnRecords.getById(turnRecordId);
	return terminalType === "outcome" ? record?.status === "succeeded" : record?.status === "failed";
}

function failureDetails(result: TurnCorrelationCommandResult | unknown): {
	code: string;
	message: string;
} {
	if (result instanceof Error) {
		return { code: "turn_terminal_recording_threw", message: result.message };
	}
	if (typeof result === "object" && result !== null && "ok" in result && result.ok === false) {
		const rejected = result as { code?: unknown; message?: unknown };
		return {
			code: typeof rejected.code === "string" ? rejected.code : "turn_terminal_recording_rejected",
			message:
				typeof rejected.message === "string"
					? rejected.message
					: "Turn terminal recording was rejected",
		};
	}
	return {
		code: "turn_terminal_recording_failed",
		message: "Turn terminal recording failed",
	};
}

export function createWorkerTurnIpcRecorder(
	deps: WorkerTurnIpcRecorderDeps,
	callbacks: WorkerTurnIpcRecorderCallbacks,
) {
	const acknowledge = (instanceId: string, workerId: string, turnRecordId: string): void => {
		callbacks.onTurnTerminalRecorded?.(instanceId, workerId, turnRecordId);
	};

	const recoverRecordingFailure = async (input: {
		instanceId: string;
		workerId: string;
		turnRecordId: string;
		terminalType: TerminalType;
		failure: unknown;
	}): Promise<void> => {
		if (terminalWasAlreadyRecorded(deps, input.turnRecordId, input.terminalType)) {
			acknowledge(input.instanceId, input.workerId, input.turnRecordId);
			return;
		}
		const details = failureDetails(input.failure);
		callbacks.onTurnTerminalRecordingFailed?.({
			instanceId: input.instanceId,
			workerId: input.workerId,
			turnRecordId: input.turnRecordId,
			terminalType: input.terminalType,
			...details,
		});
		try {
			const fallback = await deps.commands.recordWorkerFailure(input.instanceId, {
				errorCode: details.code,
				message: `Server could not durably record worker turn ${input.terminalType}: ${details.message}`,
				errorClass: "infrastructure",
			});
			if (fallback.ok || terminalWasAlreadyRecorded(deps, input.turnRecordId, "failure")) {
				acknowledge(input.instanceId, input.workerId, input.turnRecordId);
			} else {
				callbacks.onTurnTerminalRecordingFailed?.({
					instanceId: input.instanceId,
					workerId: input.workerId,
					turnRecordId: input.turnRecordId,
					terminalType: input.terminalType,
					code: "worker_failure_fallback_rejected",
					message: fallback.message,
				});
			}
		} catch (fallbackError: unknown) {
			const fallbackDetails = failureDetails(fallbackError);
			callbacks.onTurnTerminalRecordingFailed?.({
				instanceId: input.instanceId,
				workerId: input.workerId,
				turnRecordId: input.turnRecordId,
				terminalType: input.terminalType,
				code: "worker_failure_fallback_failed",
				message: fallbackDetails.message,
			});
		}
	};

	return {
		recordTurnOutcome(
			instanceId: string,
			workerId: string,
			payload: WorkerTurnOutcomePayload,
		): void {
			const { turnId, ...rest } = payload;
			if (terminalWasAlreadyRecorded(deps, rest.turnRecordId, "outcome")) {
				acknowledge(instanceId, workerId, rest.turnRecordId);
				return;
			}
			if (deps.eventIngestor.getLiveTurnRecordId(instanceId) === rest.turnRecordId) {
				deps.eventIngestor.clearLiveTurnState(instanceId);
			}
			void deps.commands
				.recordTurnOutcome(
					instanceId,
					{
						instanceId,
						turnId,
						...rest,
					},
					{ onRecorded: () => acknowledge(instanceId, workerId, rest.turnRecordId) },
				)
				.then(async (result) => {
					if (!result.ok) {
						await recoverRecordingFailure({
							instanceId,
							workerId,
							turnRecordId: rest.turnRecordId,
							terminalType: "outcome",
							failure: result,
						});
						return;
					}
					callbacks.onTurnOutcomeRecorded?.(instanceId, turnId, rest.outcome, rest.params);
				})
				.catch((error: unknown) =>
					recoverRecordingFailure({
						instanceId,
						workerId,
						turnRecordId: rest.turnRecordId,
						terminalType: "outcome",
						failure: error,
					}),
				);
		},
		recordTurnFailed(instanceId: string, workerId: string, payload: WorkerTurnFailedPayload): void {
			const { errorClass, failureCode, failureDetails: details, ...rest } = payload;
			if (errorClass !== undefined && !isWorkerErrorClass(errorClass)) {
				void recoverRecordingFailure({
					instanceId,
					workerId,
					turnRecordId: rest.turnRecordId,
					terminalType: "failure",
					failure: new Error(`Invalid worker error class '${errorClass}'`),
				});
				return;
			}
			if (terminalWasAlreadyRecorded(deps, rest.turnRecordId, "failure")) {
				acknowledge(instanceId, workerId, rest.turnRecordId);
				return;
			}
			const normalizedFailureCode =
				failureCode && isTurnFailureCode(failureCode) ? failureCode : undefined;
			if (deps.eventIngestor.getLiveTurnRecordId(instanceId) === rest.turnRecordId) {
				deps.eventIngestor.clearLiveTurnState(instanceId);
			}
			void deps.commands
				.recordTurnFailed(
					instanceId,
					{
						instanceId,
						errorClass,
						...(normalizedFailureCode
							? { failureCode: normalizedFailureCode, failureDetails: details }
							: {}),
						...rest,
					},
					{ onRecorded: () => acknowledge(instanceId, workerId, rest.turnRecordId) },
				)
				.then(async (result) => {
					if (result.ok) return;
					await recoverRecordingFailure({
						instanceId,
						workerId,
						turnRecordId: rest.turnRecordId,
						terminalType: "failure",
						failure: result,
					});
				})
				.catch((error: unknown) =>
					recoverRecordingFailure({
						instanceId,
						workerId,
						turnRecordId: rest.turnRecordId,
						terminalType: "failure",
						failure: error,
					}),
				);
		},
	};
}
