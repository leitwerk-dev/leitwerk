import type {
	ProcessInstance,
	ProcessTurnRecord,
	TurnFailedPayload,
	WorkerErrorClass,
} from "@leitwerk-dev/domain";
import { buildParkProcessWrites } from "./build-process-park-writes.js";
import { buildTurnFailedWrites } from "./build-turn-failed-writes.js";
import { createWrites, isWriteBuildFailure, mergeWrites, type Writes } from "./writes.js";

export interface WorkerFailureWritesInput {
	process: ProcessInstance;
	message: string;
	errorCode: string;
	errorClass?: WorkerErrorClass;
	activeTurnRecord?: ProcessTurnRecord | null;
	resultPiEntryId?: string | null;
	recoveryContext?: TurnFailedPayload["recoveryContext"];
	endedAt?: string;
}

function buildWorkerFailureParkWrites(input: WorkerFailureWritesInput): Writes {
	const writes = buildParkProcessWrites(
		input.process,
		{
			selectedTurnId: input.process.selectedTurnId,
			reason: input.message,
			errorClass: input.errorClass,
		},
		{ allowInactiveLifecycle: true },
	);
	if (!isWriteBuildFailure(writes)) {
		return writes;
	}
	throw new Error(
		`Invariant violation: worker failure park unexpectedly failed with '${writes.code}'`,
	);
}

function toTurnFailedPayload(input: WorkerFailureWritesInput): TurnFailedPayload | null {
	if (!input.activeTurnRecord || input.activeTurnRecord.status !== "running") {
		return null;
	}
	return {
		instanceId: input.process.id,
		turnRecordId: input.activeTurnRecord.id,
		turnId: input.activeTurnRecord.turnId,
		turnType: input.activeTurnRecord.turnType,
		pathType: input.activeTurnRecord.pathType,
		forkPiEntryId: input.activeTurnRecord.forkPiEntryId,
		resultPiEntryId: input.resultPiEntryId ?? input.activeTurnRecord.resultPiEntryId,
		errorSummary: input.message,
		errorClass: input.errorClass,
		recoveryContext: input.recoveryContext,
	};
}

export function buildWorkerFailureWrites(input: WorkerFailureWritesInput): Writes {
	const endedAt = input.endedAt ?? new Date().toISOString();
	const activeTurnRecord = input.activeTurnRecord;
	const turnFailedPayload = toTurnFailedPayload(input);
	const turnFailureWrites =
		turnFailedPayload && activeTurnRecord
			? buildTurnFailedWrites({
					process: input.process,
					payload: turnFailedPayload,
					existingTurnRecord: activeTurnRecord,
					endedAt,
				})
			: null;
	const parkWrites = buildWorkerFailureParkWrites(input);
	const writes = mergeWrites(
		turnFailureWrites ?? undefined,
		parkWrites,
		createWrites({
			workerIntent: { kind: "stop_with_reason", reason: `worker_failed:${input.errorCode}` },
		}),
	);

	for (const event of writes.events) {
		if (event.instanceId !== input.process.id || event.eventType !== "lifecycle_parked") {
			continue;
		}
		event.data = {
			...event.data,
			errorCode: input.errorCode,
		};
	}

	return writes;
}
