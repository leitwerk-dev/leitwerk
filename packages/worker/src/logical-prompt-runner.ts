import { DEFAULT_CONTINUE_PROMPT, type WorkerErrorClass } from "@leitwerk-dev/domain";
import type { LlmTurnDefinition } from "@leitwerk-dev/process-sdk";
import type { WorkerDiagnosticPayload, WorkerOperationEmitter } from "./diagnostics.js";
import {
	ensureIdentifiedPrompt,
	findIdentifiedPrompt,
	type LeitwerkPromptIdentity,
} from "./identified-pi-entry.js";
import type { PiTreeHandle, PiTurnExecutionResult } from "./pi-adapter.js";
import {
	OperatorAbortError,
	type PromptGuardScheduler,
	PromptGuardSuspension,
	PromptTimeoutError,
	promptWithGuards,
} from "./prompt-guards.js";
import { prepareContinuationUserPrompt } from "./turn-continuation.js";
import { buildTurnFailureReport, type TurnFailureReportOptions } from "./turn-execution-error.js";
import {
	TERMINAL_ACKNOWLEDGEMENT_TIMEOUT_MS,
	type ToolCompletionSnapshot,
	type TurnOutcomeSelection,
	type TurnOutcomeToolSession,
} from "./turn-outcome-tool-session.js";

const MAX_COMPACTION_CONTINUE_ATTEMPTS = 3;

export function shouldAutoContinueAfterPromptReturn(input: {
	resolvedOutcome: boolean;
	sawCompaction: boolean;
	compactionContinueAttempts: number;
}): boolean {
	return (
		!input.resolvedOutcome &&
		input.sawCompaction &&
		input.compactionContinueAttempts < MAX_COMPACTION_CONTINUE_ATTEMPTS
	);
}

function isContextWindowError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	const normalized = message.toLowerCase();
	return [
		"context_length_exceeded",
		"context length exceeded",
		"context window",
		"maximum context length",
		"max context length",
		"input is too long",
		"too many input tokens",
		"prompt is too long",
		"token limit exceeded",
	].some((marker) => normalized.includes(marker));
}

function currentLeafIsCompaction(piHandle: Pick<PiTreeHandle, "getLeafId" | "getEntry">): boolean {
	const leafId = piHandle.getLeafId();
	return leafId ? piHandle.getEntry(leafId)?.type === "compaction" : false;
}

export function shouldAutoContinueAfterCompactionError(input: {
	error: unknown;
	piHandle: Pick<PiTreeHandle, "getLeafId" | "getEntry">;
	compactionContinueAttempts: number;
}): boolean {
	return (
		input.compactionContinueAttempts < MAX_COMPACTION_CONTINUE_ATTEMPTS &&
		isContextWindowError(input.error) &&
		currentLeafIsCompaction(input.piHandle)
	);
}

export type LogicalTurnPromptPlan =
	| { kind: "prompt"; promptText: string }
	| {
			kind: "continue";
			continueUserPrompt: string | null;
			identifiedPrompt?: LeitwerkPromptIdentity;
			prepareForContinuation?: () => Promise<void>;
	  };

const DEFAULT_CONTINUATION_PLAN: LogicalTurnPromptPlan = {
	kind: "continue",
	continueUserPrompt: DEFAULT_CONTINUE_PROMPT,
};

export interface LogicalPromptAttempt<TOutcome extends string> {
	completionState: ToolCompletionSnapshot<TOutcome>;
	promptResult: PiTurnExecutionResult;
	resolvedOutcome: TurnOutcomeSelection<TOutcome> | null;
}

export async function executeLogicalPromptPlan<TOutcome extends string>(input: {
	plan: LogicalTurnPromptPlan;
	baseState?: ToolCompletionSnapshot<TOutcome>;
	turnId: string;
	turnRecordId: string;
	piHandle: PiTreeHandle;
	turnDef: LlmTurnDefinition<TOutcome, unknown, unknown>;
	toolSession: TurnOutcomeToolSession<TOutcome>;
	scheduler: PromptGuardScheduler;
	turnMaxDurationMs?: number;
	turnInactivityTimeoutMs?: number;
	turnAbortGracePeriodMs?: number;
	operatorAbortSignal?: AbortSignal;
	emit?: WorkerOperationEmitter;
	reportFailedTurn(
		errorClass: WorkerErrorClass,
		message: string,
		resultPiEntryId: string | null,
		options?: TurnFailureReportOptions,
	): Promise<never>;
}): Promise<LogicalPromptAttempt<TOutcome>> {
	input.toolSession.reset(input.baseState);
	const trace = (payload: WorkerDiagnosticPayload) => input.emit?.({ kind: "trace", payload });
	const reportError = (payload: WorkerDiagnosticPayload) =>
		input.emit?.({ kind: "error", payload });
	const taint = (reason: string) => input.emit?.({ kind: "session_tainted", reason });
	let currentPlan = input.plan;
	let compactionContinueAttempts = 0;
	const reportFailure = (
		error: unknown,
		args: {
			code: string;
			emitWorkerError?: boolean;
			fallbackErrorClass?: WorkerErrorClass;
			messagePrefix?: string;
		},
	): Promise<never> => {
		const failure = buildTurnFailureReport(error, {
			turnId: input.turnId,
			currentLeafId: input.piHandle.getLeafId(),
			fallbackErrorClass: args.fallbackErrorClass,
			messagePrefix: args.messagePrefix,
		});
		if (failure.taintReason) {
			taint(failure.taintReason);
		}
		if (args.emitWorkerError ?? true) {
			reportError({
				level: "error",
				code: args.code,
				message: failure.message,
				turnRecordId: input.turnRecordId,
				turnId: input.turnId,
				errorClass: failure.errorClass,
				...(failure.details ? { details: failure.details } : {}),
			});
		}
		return input.reportFailedTurn(
			failure.errorClass,
			failure.message,
			failure.resultPiEntryId,
			failure.options,
		);
	};

	for (;;) {
		const plan = currentPlan;
		const guardSuspension = new PromptGuardSuspension();
		const promptOptions =
			input.toolSession.tools.length > 0
				? {
						tools: input.toolSession.tools,
						activeTools: input.toolSession.activeTools,
						shouldBlockToolCall: (toolName: string) =>
							input.toolSession.shouldBlockToolCall(toolName),
						suspendPromptGuards: () => guardSuspension.suspend(),
						terminalAcknowledgement: {
							...input.toolSession.terminalAcknowledgement,
							timeoutMs: TERMINAL_ACKNOWLEDGEMENT_TIMEOUT_MS,
							isOperatorAbortRequested: () => input.operatorAbortSignal?.aborted === true,
						},
					}
				: { activeTools: input.toolSession.activeTools };

		let runPrompt = () =>
			plan.kind === "continue"
				? input.piHandle.continueTurn(promptOptions)
				: input.piHandle.prompt(plan.promptText ?? "", promptOptions);
		if (plan.kind === "continue") {
			try {
				await plan.prepareForContinuation?.();
				if (plan.continueUserPrompt !== null) {
					const content = plan.continueUserPrompt;
					const identity = plan.identifiedPrompt;
					if (identity) {
						const expectedParentId = input.piHandle.getLeafId();
						if (findIdentifiedPrompt(input.piHandle, identity)) {
							await ensureIdentifiedPrompt({
								piHandle: input.piHandle,
								identity,
								content,
								expectedParentId,
							});
						} else {
							runPrompt = () =>
								input.piHandle.promptCustom({ content, details: identity }, promptOptions);
						}
					} else {
						const promptText = await prepareContinuationUserPrompt({
							piHandle: input.piHandle,
							turnId: input.turnId,
							promptText: content,
						});
						if (promptText) {
							runPrompt = () => input.piHandle.promptLiteral(promptText, promptOptions);
						}
					}
				}
			} catch (error: unknown) {
				return reportFailure(error, { code: "turn.continue_prepare_failed" });
			}
		}

		try {
			const attempt = await promptWithGuards(
				{
					scheduler: input.scheduler,
					turnMaxDurationMs: input.turnMaxDurationMs,
					turnInactivityTimeoutMs: input.turnInactivityTimeoutMs,
					turnAbortGracePeriodMs: input.turnAbortGracePeriodMs,
					operatorAbortSignal: input.operatorAbortSignal,
					guardSuspension,
					emit: input.emit,
				},
				{
					piHandle: input.piHandle,
					turnRecordId: input.turnRecordId,
					turnId: input.turnId,
					runPrompt,
				},
			);
			if (input.toolSession.terminalAcknowledgement.state() === "outcome_accepted") {
				input.toolSession.terminalAcknowledgement.markFailed(
					"Terminal acknowledgement did not complete and was ignored",
				);
			}
			const completionState = input.toolSession.getCompletionState();
			const acknowledgementFailure = input.toolSession.terminalAcknowledgement.failureReason();
			if (acknowledgementFailure) {
				trace({
					level: "warn",
					code: "turn.terminal_acknowledgement_failed_ignored",
					message: acknowledgementFailure,
					turnRecordId: input.turnRecordId,
					turnId: input.turnId,
				});
			}
			const resolvedOutcome = input.toolSession.resolveOutcome(input.turnDef);
			if (
				shouldAutoContinueAfterPromptReturn({
					resolvedOutcome: resolvedOutcome !== null,
					sawCompaction: attempt.sawCompaction,
					compactionContinueAttempts,
				})
			) {
				compactionContinueAttempts += 1;
				trace({
					level: "info",
					code: "turn.compaction_continue_requested",
					message: `Turn '${input.turnId}' requested an explicit continue after compaction`,
					turnRecordId: input.turnRecordId,
					turnId: input.turnId,
					details: {
						attempt: compactionContinueAttempts,
						resultPiEntryId: attempt.result.resultEntryId,
					},
				});
				currentPlan = DEFAULT_CONTINUATION_PLAN;
				continue;
			}
			return {
				completionState,
				promptResult: attempt.result,
				resolvedOutcome,
			};
		} catch (error: unknown) {
			if (
				shouldAutoContinueAfterCompactionError({
					error,
					piHandle: input.piHandle,
					compactionContinueAttempts,
				})
			) {
				compactionContinueAttempts += 1;
				trace({
					level: "info",
					code: "turn.compaction_error_continue_requested",
					message: `Turn '${input.turnId}' requested an explicit continue after context-window compaction`,
					turnRecordId: input.turnRecordId,
					turnId: input.turnId,
					details: {
						attempt: compactionContinueAttempts,
						resultPiEntryId: input.piHandle.getLeafId(),
					},
				});
				currentPlan = DEFAULT_CONTINUATION_PLAN;
				continue;
			}
			return reportFailure(error, {
				code: plan.kind === "continue" ? "turn.continue_failed" : "turn.prompt_failed",
				emitWorkerError: !(
					error instanceof PromptTimeoutError || error instanceof OperatorAbortError
				),
				fallbackErrorClass: "llm_error",
				messagePrefix:
					plan.kind === "continue"
						? `Turn '${input.turnId}' continuation failed`
						: `Turn '${input.turnId}' prompt failed`,
			});
		}
	}
}
