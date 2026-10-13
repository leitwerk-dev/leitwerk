import type { FailedTurnRecoveryContext } from "@leitwerk-dev/domain";
import type { WorkerDiagnosticPayload, WorkerOperationEmitter } from "./diagnostics.js";
import type { LogicalPromptAttempt, LogicalTurnPromptPlan } from "./logical-prompt-runner.js";
import type { PiTreeHandle } from "./pi-adapter.js";
import type {
	ToolCompletionSnapshot,
	TurnOutcomeToolSession,
} from "./turn-outcome-tool-session.js";

export const MAX_MISSING_TOOL_CALL_RECOVERY_ATTEMPTS = 3;

export async function runMissingToolRecovery<TOutcome extends string>(input: {
	turnId: string;
	turnRecordId: string;
	piHandle: PiTreeHandle;
	initialAttempt: LogicalPromptAttempt<TOutcome>;
	toolSession: TurnOutcomeToolSession<TOutcome>;
	emit?: WorkerOperationEmitter;
	executeLogicalPromptPlan(
		plan: LogicalTurnPromptPlan,
		options?: { baseState?: ToolCompletionSnapshot<TOutcome> },
	): Promise<LogicalPromptAttempt<TOutcome>>;
}): Promise<{
	finalAttempt: LogicalPromptAttempt<TOutcome>;
	failure?: { recoveryContext: FailedTurnRecoveryContext; description: string };
}> {
	const trace = (payload: WorkerDiagnosticPayload) => input.emit?.({ kind: "trace", payload });
	const reportError = (payload: WorkerDiagnosticPayload) =>
		input.emit?.({ kind: "error", payload });
	let recovery = input.toolSession.resolveMissingToolRecovery(input.initialAttempt.completionState);
	if (!recovery) {
		return { finalAttempt: input.initialAttempt };
	}

	let recoveryContext = input.toolSession.buildRecoveryContext(recovery);
	let description = input.toolSession.describeRecovery(recovery);
	reportError({
		level: "warn",
		code: recovery.rejectedOutcome ? "turn.outcome_rejected" : "turn.required_tool_call_missing",
		message: `Turn '${input.turnId}' did not complete: ${description}`,
		turnRecordId: input.turnRecordId,
		turnId: input.turnId,
		errorClass: "protocol_error",
		details: {
			attemptBudget: MAX_MISSING_TOOL_CALL_RECOVERY_ATTEMPTS,
			missingToolNames: recovery.missingToolNames,
		},
	});

	let finalAttempt = input.initialAttempt;
	let unchangedRejections = 0;
	for (
		let recoveryAttempt = 1;
		recoveryAttempt <= MAX_MISSING_TOOL_CALL_RECOVERY_ATTEMPTS;
		recoveryAttempt += 1
	) {
		trace({
			level: "info",
			code: "turn.required_tool_call_retry_requested",
			message: `Turn '${input.turnId}' is retrying: ${description}`,
			turnRecordId: input.turnRecordId,
			turnId: input.turnId,
			details: {
				recoveryAttempt,
				missingToolNames: recovery.missingToolNames,
			},
		});
		const previousAttempt = finalAttempt;
		finalAttempt = await input.executeLogicalPromptPlan(
			{
				kind: "continue",
				continueUserPrompt: recoveryContext.suggestedContinuePrompt,
				prepareForContinuation: async () =>
					await input.piHandle.branch(previousAttempt.promptResult.resultEntryId),
			},
			{ baseState: previousAttempt.completionState },
		);
		const nextRecovery = input.toolSession.resolveMissingToolRecovery(finalAttempt.completionState);
		if (!nextRecovery) return { finalAttempt };
		unchangedRejections =
			recovery.rejectedOutcome &&
			JSON.stringify(recovery.rejectedOutcome) === JSON.stringify(nextRecovery.rejectedOutcome)
				? unchangedRejections + 1
				: 0;
		recovery = nextRecovery;
		recoveryContext = input.toolSession.buildRecoveryContext(recovery);
		description = input.toolSession.describeRecovery(recovery);
		if (unchangedRejections >= 2) break;
	}

	reportError({
		level: "error",
		code: "turn.required_tool_call_retry_exhausted",
		message: `Turn '${input.turnId}' stopped automatic recovery: ${description}`,
		turnRecordId: input.turnRecordId,
		turnId: input.turnId,
		errorClass: "protocol_error",
		details: {
			missingToolNames: recovery.missingToolNames,
		},
	});
	return {
		finalAttempt,
		failure: { recoveryContext, description },
	};
}
