import type {
	ProcessInstance,
	ProcessTurnRecordPathType,
	ProcessTurnType,
} from "@leitwerk-dev/domain";
import type { PiTreeHandle } from "./pi-adapter.js";
import { classifyRuntimeError, TurnExecutionError } from "./turn-execution-error.js";
import { TurnExecutionFailure, type TurnExecutionMeta } from "./turn-execution-result.js";
import { resolveTurnRecordIdForExecution } from "./turn-record-id.js";
import { resolveRootEntryIdFromHandle } from "./turn-tree-strategy.js";
import { readProcessSemanticEntryRefs } from "./worker-payloads.js";

export interface AutomaticTurnResult {
	turnId: string;
	outcome: string;
	params: Record<string, unknown>;
	meta: TurnExecutionMeta;
}

export interface AutomaticTurnExecutor {
	readonly turnRecordId: string;
	readonly result: AutomaticTurnResult | null;
	complete<TOutcome extends string>(input: {
		outcome: TOutcome;
		params?: Record<string, unknown>;
		markdown?: string | null;
	}): Promise<void>;
	failure(error: unknown): TurnExecutionFailure;
	assertCompletedUnlessParked(parked: boolean): void;
}

export function createAutomaticTurnExecutor(input: {
	currentTurnId: string;
	processSnapshot: Pick<ProcessInstance, "selectedTurnId">;
	acceptedTurnRecordId: string | null;
	state: unknown;
	piHandle: PiTreeHandle | null;
}): AutomaticTurnExecutor {
	const turnType: ProcessTurnType = "automatic";
	const pathType: ProcessTurnRecordPathType = "primary";
	const turnRecordId = resolveTurnRecordIdForExecution(
		input.processSnapshot,
		input.currentTurnId,
		input.acceptedTurnRecordId,
	);
	let result: AutomaticTurnResult | null = null;

	const failure = (error: unknown): TurnExecutionFailure => {
		const classified = classifyRuntimeError(error);
		const turnError =
			error instanceof TurnExecutionError
				? error
				: new TurnExecutionError(input.currentTurnId, classified.errorClass, classified.message);
		return new TurnExecutionFailure({
			turnRecordId,
			turnId: input.currentTurnId,
			turnType,
			pathType,
			failure: turnError,
		});
	};

	return {
		turnRecordId,
		get result() {
			return result;
		},
		async complete(completeInput) {
			if (result) {
				throw new TurnExecutionError(
					input.currentTurnId,
					"protocol_error",
					`Automatic turn '${input.currentTurnId}' completed more than once`,
				);
			}
			result = {
				turnId: input.currentTurnId,
				outcome: completeInput.outcome,
				params: completeInput.params ?? {},
				meta: {
					turnRecordId,
					turnType,
					pathType,
					forkPiEntryId: null,
					resultPiEntryId: null,
					turnResultMarkdown: completeInput.markdown ?? null,
					rootEntryId: input.piHandle
						? resolveRootEntryIdFromHandle(input.piHandle)
						: (readProcessSemanticEntryRefs(input.state)?.rootEntry?.entryId ?? null),
				},
			};
		},
		failure,
		assertCompletedUnlessParked(parked) {
			if (!result && !parked) {
				throw failure(
					new TurnExecutionError(
						input.currentTurnId,
						"protocol_error",
						`Automatic turn '${input.currentTurnId}' returned without calling run.complete()`,
					),
				);
			}
		},
	};
}
