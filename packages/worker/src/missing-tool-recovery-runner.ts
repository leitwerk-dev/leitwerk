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
	recovered: boolean;
	finalAttempt: LogicalPromptAttempt<TOutcome>;
	recoveryContext: FailedTurnRecoveryContext | null;
	baseMissingToolRecoveryDescription: string | null;
}> {
	const trace = (payload: WorkerDiagnosticPayload) => input.emit?.({ kind: "trace", payload });
	const reportError = (payload: WorkerDiagnosticPayload) =>
		input.emit?.({ kind: "error", payload });
	const baseMissingToolRecovery = input.toolSession.resolveMissingToolRecovery(
		input.initialAttempt.completionState,
	);
	if (!baseMissingToolRecovery) {
		return {
			recovered: true,
			finalAttempt: input.initialAttempt,
			recoveryContext: null,
			baseMissingToolRecoveryDescription: null,
		};
	}

	const recoveryContext = input.toolSession.buildRecoveryContext(baseMissingToolRecovery);
	const description = input.toolSession.describeRecovery(baseMissingToolRecovery);
	reportError({
		level: "warn",
		code: "turn.required_tool_call_missing",
		message: `Turn '${input.turnId}' is missing required tool calls: ${description}`,
		turnRecordId: input.turnRecordId,
		turnId: input.turnId,
		errorClass: "protocol_error",
		details: {
			attemptBudget: MAX_MISSING_TOOL_CALL_RECOVERY_ATTEMPTS,
			missingToolNames: baseMissingToolRecovery.missingToolNames,
		},
	});

	let finalAttempt = input.initialAttempt;
	for (
		let recoveryAttempt = 1;
		recoveryAttempt <= MAX_MISSING_TOOL_CALL_RECOVERY_ATTEMPTS;
		recoveryAttempt += 1
	) {
		trace({
			level: "info",
			code: "turn.required_tool_call_retry_requested",
			message: `Turn '${input.turnId}' is retrying after a missing required tool call`,
			turnRecordId: input.turnRecordId,
			turnId: input.turnId,
			details: {
				recoveryAttempt,
				missingToolNames: baseMissingToolRecovery.missingToolNames,
			},
		});
		finalAttempt = await input.executeLogicalPromptPlan(
			{
				kind: "continue",
				continueUserPrompt: recoveryContext.suggestedContinuePrompt,
				prepareForContinuation: async () =>
					await input.piHandle.branch(input.initialAttempt.promptResult.resultEntryId),
			},
			{ baseState: input.initialAttempt.completionState },
		);
		if (!input.toolSession.resolveMissingToolRecovery(finalAttempt.completionState)) {
			return {
				recovered: true,
				finalAttempt,
				recoveryContext,
				baseMissingToolRecoveryDescription: description,
			};
		}
	}

	reportError({
		level: "error",
		code: "turn.required_tool_call_retry_exhausted",
		message: `Turn '${input.turnId}' still missed required tool calls after ${MAX_MISSING_TOOL_CALL_RECOVERY_ATTEMPTS} automatic recovery attempts`,
		turnRecordId: input.turnRecordId,
		turnId: input.turnId,
		errorClass: "protocol_error",
		details: {
			missingToolNames: baseMissingToolRecovery.missingToolNames,
		},
	});
	return {
		recovered: false,
		finalAttempt,
		recoveryContext,
		baseMissingToolRecoveryDescription: description,
	};
}
