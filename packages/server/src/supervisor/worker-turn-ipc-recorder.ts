import {
	createGenericFailedTurnRecoveryContext,
	type FailedTurnRecoveryContext,
	isTurnFailureCode,
	isWorkerErrorClass,
} from "@leitwerk-dev/domain";
import type {
	WorkerTurnFailedPayload,
	WorkerTurnOutcomePayload,
} from "@leitwerk-dev/worker-protocol";
import type { RepositoryBundle } from "../db/repositories.js";
import type { ProcessEngine } from "../process-engine/types.js";
import type { createWorkerEventIngestor } from "./worker-event-ingestor.js";

export interface WorkerTurnIpcRecorderDeps extends Pick<RepositoryBundle, "turnRecords"> {
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

type TerminalType = "outcome" | "failure";

type TerminalRecordingFailureInput = {
	instanceId: string;
	workerId: string;
	turnRecordId: string;
	terminalType: TerminalType;
	failure: unknown;
	resultPiEntryId?: string | null;
	recoveryContext?: FailedTurnRecoveryContext | null;
};

function terminalWasAlreadyRecorded(
	deps: Pick<WorkerTurnIpcRecorderDeps, "turnRecords">,
	turnRecordId: string,
	terminalType: TerminalType,
): boolean {
	const record = deps.turnRecords.getById(turnRecordId);
	return terminalType === "outcome" ? record?.status === "succeeded" : record?.status === "failed";
}

function failureDetails(result: unknown): {
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
	const reportRecordingFailure = (
		input: Parameters<NonNullable<typeof callbacks.onTurnTerminalRecordingFailed>>[0],
	): void => {
		try {
			callbacks.onTurnTerminalRecordingFailed?.(input);
		} catch {
			// Observability must not prevent durable failure recovery or terminal replay.
		}
	};

	const recoverRecordingFailure = async (input: TerminalRecordingFailureInput): Promise<void> => {
		if (terminalWasAlreadyRecorded(deps, input.turnRecordId, input.terminalType)) {
			acknowledge(input.instanceId, input.workerId, input.turnRecordId);
			return;
		}
		const details = failureDetails(input.failure);
		reportRecordingFailure({
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
				resultPiEntryId: input.resultPiEntryId,
				recoveryContext: input.recoveryContext,
			});
			if (fallback.ok || terminalWasAlreadyRecorded(deps, input.turnRecordId, "failure")) {
				acknowledge(input.instanceId, input.workerId, input.turnRecordId);
			} else {
				reportRecordingFailure({
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
			reportRecordingFailure({
				instanceId: input.instanceId,
				workerId: input.workerId,
				turnRecordId: input.turnRecordId,
				terminalType: input.terminalType,
				code: "worker_failure_fallback_failed",
				message: fallbackDetails.message,
			});
		}
	};
	const recover =
		(input: Omit<TerminalRecordingFailureInput, "failure">) =>
		(failure: unknown): Promise<void> =>
			recoverRecordingFailure({ ...input, failure });
	const clearLiveTurn = (instanceId: string, turnRecordId: string): void => {
		if (deps.eventIngestor.getLiveTurnRecordId(instanceId) === turnRecordId) {
			deps.eventIngestor.clearLiveTurnState(instanceId);
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
			clearLiveTurn(instanceId, rest.turnRecordId);
			const recoverOutcome = recover({
				instanceId,
				workerId,
				turnRecordId: rest.turnRecordId,
				terminalType: "outcome",
				resultPiEntryId: rest.resultPiEntryId,
				recoveryContext: createGenericFailedTurnRecoveryContext(),
			});
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
				.then((result) => {
					if (!result.ok) return recoverOutcome(result);
					callbacks.onTurnOutcomeRecorded?.(instanceId, turnId, rest.outcome, rest.params);
				})
				.catch(recoverOutcome);
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
			clearLiveTurn(instanceId, rest.turnRecordId);
			const recoverFailure = recover({
				instanceId,
				workerId,
				turnRecordId: rest.turnRecordId,
				terminalType: "failure",
				resultPiEntryId: rest.resultPiEntryId,
				recoveryContext: rest.recoveryContext,
			});
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
				.then((result) => (result.ok ? undefined : recoverFailure(result)))
				.catch(recoverFailure);
		},
	};
}
