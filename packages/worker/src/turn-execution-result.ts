import type { ProcessTurnRecordPathType, ProcessTurnType } from "@leitwerk-dev/domain";
import type { TurnResult } from "@leitwerk-dev/process-sdk";
import type { TurnExecutionError } from "./turn-execution-error.js";

export interface TurnExecutionMeta {
	turnRecordId: string;
	turnType: ProcessTurnType;
	pathType: ProcessTurnRecordPathType;
	forkPiEntryId?: string | null;
	resultPiEntryId?: string | null;
	turnResultMarkdown?: string | null;
	rootEntryId?: string | null;
}

export interface LlmTurnExecutionSuccess<TOutcome extends string> {
	turnResult: TurnResult<TOutcome>;
	meta: TurnExecutionMeta;
}

export class TurnExecutionFailure extends Error {
	readonly turnRecordId: string;
	readonly turnId: string;
	readonly turnType: ProcessTurnType;
	readonly pathType: ProcessTurnRecordPathType;
	readonly failure: TurnExecutionError;
	readonly forkPiEntryId: string | null;
	readonly resultPiEntryId: string | null;

	constructor(input: {
		turnRecordId: string;
		turnId: string;
		turnType: ProcessTurnType;
		pathType: ProcessTurnRecordPathType;
		failure: TurnExecutionError;
		forkPiEntryId?: string | null;
		resultPiEntryId?: string | null;
	}) {
		super(input.failure.message, { cause: input.failure });
		this.name = "TurnExecutionFailure";
		this.turnRecordId = input.turnRecordId;
		this.turnId = input.turnId;
		this.turnType = input.turnType;
		this.pathType = input.pathType;
		this.failure = input.failure;
		this.forkPiEntryId = input.forkPiEntryId ?? null;
		this.resultPiEntryId = input.resultPiEntryId ?? null;
	}
}
