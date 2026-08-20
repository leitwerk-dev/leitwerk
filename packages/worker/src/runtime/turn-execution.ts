import {
	failActiveTurnProgress,
	type ProcessSemanticEntryRefKey,
	type TurnProgressReport,
} from "@leitwerk-dev/domain";
import type {
	LlmTurnDefinition,
	TurnOptions,
	TurnResult,
	WorkerProcessContext,
	WorkerRunHandle,
} from "@leitwerk-dev/process-sdk";
import { assertValidLlmTurnDefinition } from "@leitwerk-dev/process-sdk";
import { createAutomaticTurnExecutor } from "../automatic-turn-executor.js";
import type { WorkerOperationEmitter } from "../diagnostics.js";
import type { PiTreeHandle } from "../pi-adapter.js";
import type { PreTurnTargetedInput } from "../pre-turn-targeted-inputs.js";
import type { WorkerQuestionRequest } from "../question-tool.js";
import { TurnExecutionError } from "../turn-execution-error.js";
import { TurnExecutionFailure, type TurnExecutionMeta } from "../turn-execution-result.js";
import type { ResultImageToolFactory, WorkerRuntimeScheduler } from "./adapters.js";
import type { PreparedWorkerSession } from "./bootstrap-session.js";
import { executeLlmTurn } from "./llm-turn-execution.js";

export interface AppliedTargetedInput {
	inputId: string;
	sequence: number;
	meta?: {
		currentPrimaryPathLeafId?: string | null;
		rootEntryId?: string | null;
		targetSemanticRef?: ProcessSemanticEntryRefKey | null;
		targetProductName?: string | null;
		targetEntryId?: string | null;
	};
}

export type SelectedTurnExecutionResult =
	| {
			kind: "outcome";
			turnId: string;
			outcome: string;
			params: Record<string, unknown>;
			meta: TurnExecutionMeta;
			appliedTargetedInputs: readonly AppliedTargetedInput[];
	  }
	| {
			kind: "failed";
			failure: TurnExecutionFailure;
			appliedTargetedInputs: readonly AppliedTargetedInput[];
	  }
	| { kind: "parked"; reason?: string; appliedTargetedInputs: readonly AppliedTargetedInput[] };

export interface SelectedTurnExecutionInput {
	session: PreparedWorkerSession;
	piHandle: PiTreeHandle | null;
	turnRecordId: string;
	targetedInputs: readonly PreTurnTargetedInput[];
	scheduler: WorkerRuntimeScheduler;
	resultImageTools: ResultImageToolFactory;
	requestQuestions?: (request: WorkerQuestionRequest) => Promise<string[]>;
	integrationTools?: readonly import("@leitwerk-dev/process-sdk").PiCustomTool[];
	signal: AbortSignal;
	emit: WorkerOperationEmitter;
}

function failedResult(
	failure: TurnExecutionFailure,
	appliedTargetedInputs: readonly AppliedTargetedInput[],
): SelectedTurnExecutionResult {
	return { kind: "failed", failure, appliedTargetedInputs };
}

/** Execute one accepted selected turn and return its single terminal fact. */
export async function executeSelectedTurn(
	input: SelectedTurnExecutionInput,
): Promise<SelectedTurnExecutionResult> {
	const { resolvedWorkerProcess, processSnapshot, projectSnapshots } = input.session;
	const { piHandle } = input;
	const currentTurnId = input.session.selectedTurnId;
	const selectedTurnType = input.session.kind;
	if (selectedTurnType === "llm" && !piHandle) {
		throw new TurnExecutionError(
			currentTurnId,
			"infrastructure",
			`Turn '${currentTurnId}' requires a Pi handle`,
		);
	}
	const handler = resolvedWorkerProcess.definition.turns.get(currentTurnId);
	if (!handler) throw new Error(`Validated turn handler '${currentTurnId}' is unavailable`);
	let automaticIntegrationCallIndex = 0;
	let latestProgressReport: TurnProgressReport | null = null;

	const ctx = {
		process: processSnapshot,
		projects: projectSnapshots,
		params: resolvedWorkerProcess.params,
		state: resolvedWorkerProcess.state,
		turnResultMarkdownBySemanticRef: input.session.turnResultMarkdownBySemanticRef,
		turnResultMarkdownByProduct: input.session.turnResultMarkdownByProduct,
		workspaceRoot: input.session.workspaceRoot,
		...(selectedTurnType === "automatic"
			? {
					reportProgress(report: TurnProgressReport) {
						latestProgressReport = report;
						input.emit({ kind: "progress", turnRecordId: input.turnRecordId, report });
					},
					async callIntegrationTool(name: string, args: Record<string, unknown>) {
						const tool = input.integrationTools?.find((candidate) => candidate.name === name);
						if (!tool) {
							throw new Error(
								`Integration tool '${name}' is not authorized for turn '${currentTurnId}'`,
							);
						}
						automaticIntegrationCallIndex += 1;
						return tool.execute(args, {
							toolCallId: `${input.turnRecordId}:${automaticIntegrationCallIndex}:${name}`,
							signal: input.signal,
						});
					},
				}
			: {}),
	} as WorkerProcessContext;
	let terminal: SelectedTurnExecutionResult | null = null;
	const appliedTargetedInputs: AppliedTargetedInput[] = [];
	let parked = false;
	let parkReason: string | undefined;
	const automaticExecutor =
		selectedTurnType === "automatic"
			? createAutomaticTurnExecutor({
					currentTurnId,
					processSnapshot,
					acceptedTurnRecordId: input.turnRecordId,
					state: ctx.state,
					piHandle,
				})
			: null;

	const run: WorkerRunHandle = {
		ctx,
		async turn<TOutcome extends string>(
			turnDef: LlmTurnDefinition<TOutcome, unknown, unknown>,
			_options?: TurnOptions,
		): Promise<TurnResult<TOutcome>> {
			if (selectedTurnType !== "llm") {
				throw new TurnExecutionError(
					currentTurnId,
					"protocol_error",
					`Selected turn '${currentTurnId}' of type '${selectedTurnType}' cannot call run.turn()`,
				);
			}
			assertValidLlmTurnDefinition(currentTurnId, turnDef);
			if (!piHandle) {
				throw new TurnExecutionError(
					currentTurnId,
					"infrastructure",
					`Turn '${currentTurnId}' requires a Pi handle`,
				);
			}
			const completed = await executeLlmTurn({
				resolvedWorkerProcess,
				ctx,
				piHandle,
				turnDef,
				turnId: currentTurnId,
				acceptedTurnRecordId: input.turnRecordId,
				turnStartRecordId: input.session.startRecordId,
				preparedTurnStart: input.session.kind === "llm" ? input.session.preparedTurnStart : null,
				configSnapshot: input.session.kind === "llm" ? input.session.configSnapshot : undefined,
				preTurnTargetedInputs: input.targetedInputs,
				scheduler: input.scheduler,
				resultImageTools: input.resultImageTools,
				turnMaxDurationMs: input.session.settings.turnMaxDurationMs,
				turnInactivityTimeoutMs: input.session.settings.turnInactivityTimeoutMs,
				turnAbortGracePeriodMs: input.session.settings.turnAbortGracePeriodMs,
				operatorAbortSignal: input.signal,
				callbacks: {
					requestQuestions: input.requestQuestions,
					integrationTools: input.integrationTools,
					onPreTurnTargetedInputApplied(inputId, sequence, meta) {
						appliedTargetedInputs.push({ inputId, sequence, ...(meta ? { meta } : {}) });
					},
					emit: input.emit,
				},
			});
			terminal = {
				kind: "outcome",
				turnId: currentTurnId,
				outcome: completed.turnResult.outcome,
				params: completed.turnResult.params,
				meta: completed.meta,
				appliedTargetedInputs,
			};
			return completed.turnResult;
		},
		async complete(completeInput) {
			if (!automaticExecutor) {
				throw new TurnExecutionError(
					currentTurnId,
					"protocol_error",
					`Selected turn '${currentTurnId}' cannot call run.complete()`,
				);
			}
			await automaticExecutor.complete(completeInput);
		},
		park(reason?: string) {
			parked = true;
			parkReason = reason;
		},
	};

	try {
		await handler(run);
		automaticExecutor?.assertCompletedUnlessParked(parked);
		if (parked) return { kind: "parked", reason: parkReason, appliedTargetedInputs };
		if (automaticExecutor?.result) {
			return { kind: "outcome", ...automaticExecutor.result, appliedTargetedInputs };
		}
		if (!terminal) {
			throw new TurnExecutionError(
				currentTurnId,
				"protocol_error",
				`Selected turn '${currentTurnId}' returned without an outcome or park`,
			);
		}
		return terminal;
	} catch (error) {
		const failedProgressReport = latestProgressReport as TurnProgressReport | null;
		if (failedProgressReport) {
			input.emit({
				kind: "progress",
				turnRecordId: input.turnRecordId,
				report: failActiveTurnProgress(failedProgressReport),
			});
		}
		if (error instanceof TurnExecutionFailure) return failedResult(error, appliedTargetedInputs);
		if (automaticExecutor)
			return failedResult(automaticExecutor.failure(error), appliedTargetedInputs);
		throw error;
	}
}
