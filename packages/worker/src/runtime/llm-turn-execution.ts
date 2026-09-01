import {
	createGenericFailedTurnRecoveryContext,
	DEFAULT_CONTINUE_PROMPT,
	type PreparedTurnStart,
	type ProcessTurnRecordPathType,
	type ProcessTurnType,
	type WorkerErrorClass,
} from "@leitwerk-dev/domain";
import type { ResolvedWorkerProcess } from "@leitwerk-dev/extension-runtime";
import type {
	LlmTurnDefinition,
	PiTreeNode,
	WorkerProcessContext,
} from "@leitwerk-dev/process-sdk";
import { resolveLlmTurnRestorePrimaryLeafAfterTurn } from "@leitwerk-dev/process-sdk";
import type { ConfigSnapshot } from "@leitwerk-dev/protocol";
import type { WorkerDiagnosticPayload, WorkerOperationEmitter } from "../diagnostics.js";
import {
	ensureIdentifiedCompaction,
	findIdentifiedPrompt,
	validateIdentifiedPrompt,
} from "../identified-pi-entry.js";
import {
	type LogicalTurnPromptPlan,
	executeLogicalPromptPlan as runLogicalPromptPlan,
} from "../logical-prompt-runner.js";
import {
	MAX_MISSING_TOOL_CALL_RECOVERY_ATTEMPTS,
	runMissingToolRecovery,
} from "../missing-tool-recovery-runner.js";
import type { PiTreeHandle } from "../pi-adapter.js";
import {
	applyPreTurnTargetedInputs,
	type PreTurnTargetedInput,
	resolvePreTurnTargetStartSelection,
	validatePreTurnTargetedInputs,
} from "../pre-turn-targeted-inputs.js";
import type { WorkerQuestionRequest } from "../question-tool.js";
import {
	resolvePromptlessTurnResumeReason,
	resolveTurnContinuationState,
} from "../turn-continuation.js";
import {
	buildTurnFailureReport,
	TurnExecutionError,
	type TurnFailureReportOptions,
	toErrorMessage,
} from "../turn-execution-error.js";
import { type LlmTurnExecutionSuccess, TurnExecutionFailure } from "../turn-execution-result.js";
import {
	createTurnOutcomeToolSession,
	type ToolCompletionSnapshot,
} from "../turn-outcome-tool-session.js";
import { resolveTurnRecordIdForExecution } from "../turn-record-id.js";
import {
	planTurnTreeExecution,
	positionHandleForTurn,
	resolveRootEntryIdFromHandle,
	restoreHandleAfterTurn,
	type TurnTreePlan,
} from "../turn-tree-strategy.js";
import { readProcessProductRefs, readProcessSemanticEntryRefs } from "../worker-payloads.js";
import type { ResultImageToolFactory, WorkerRuntimeScheduler } from "./adapters.js";

export {
	shouldAutoContinueAfterCompactionError,
	shouldAutoContinueAfterPromptReturn,
} from "../logical-prompt-runner.js";

function buildPromptlessTargetedFollowUpGuidance(input: {
	turnId: string;
	activeToolNames: readonly string[];
	promptSuffix: string;
}): string {
	const activeTools = input.activeToolNames.length > 0 ? input.activeToolNames.join(", ") : "none";
	return [
		[
			"Active-turn handoff:",
			`- This queued follow-up is now running turn '${input.turnId}'. The task and tool availability may differ from the prior branch context.`,
			`- Active built-in tools for this turn: ${activeTools}. Use only these built-in tools, plus any custom/outcome tools exposed for this turn.`,
			"- Treat these active-turn instructions and tool availability as authoritative where they conflict with earlier branch instructions.",
		].join("\n"),
		input.promptSuffix.trim(),
	]
		.filter((section) => section !== "")
		.join("\n\n");
}

function appendGuidanceToLastTargetedInput(
	inputs: readonly PreTurnTargetedInput[],
	guidance: string | null,
): readonly PreTurnTargetedInput[] {
	if (!guidance || inputs.length === 0) {
		return inputs;
	}
	return inputs.map((targetedInput, index) =>
		index === inputs.length - 1
			? {
					...targetedInput,
					bodyMarkdown: `${targetedInput.bodyMarkdown.trimEnd()}\n\n${guidance}`,
				}
			: targetedInput,
	);
}

export interface LlmTurnExecutorCallbacks {
	requestQuestions?: (request: WorkerQuestionRequest) => Promise<string[]>;
	onPreTurnTargetedInputApplied?(
		inputId: string,
		sequence: number,
		meta?: {
			currentPrimaryPathLeafId?: string | null;
			rootEntryId?: string | null;
			targetSemanticRef?: import("@leitwerk-dev/domain").ProcessSemanticEntryRefKey | null;
			targetProductName?: string | null;
			targetEntryId?: string | null;
		},
	): void;
	emit?: WorkerOperationEmitter;
	integrationTools?: readonly import("@leitwerk-dev/process-sdk").PiCustomTool[];
}

/** Pi writes these on new sessions before any conversational content exists. */
const PI_SESSION_BOOTSTRAP_ENTRY_TYPES = new Set(["model_change", "thinking_level_change"]);

function visitPiTreeEntries(
	nodes: readonly PiTreeNode[],
	visit: (entryType: string) => void,
): void {
	for (const node of nodes) {
		visit(node.entry.type);
		visitPiTreeEntries(node.children, visit);
	}
}

/**
 * Empty-tree prepared starts mean "no conversational fork yet". Pi still appends
 * model/thinking bootstrap entries when activating a new session, so those alone
 * must not invalidate the receipt.
 */
export function isPiTreeEmptyForPreparedEmptyPlan(
	piHandle: Pick<PiTreeHandle, "getTree">,
): boolean {
	let hasNonBootstrap = false;
	visitPiTreeEntries(piHandle.getTree(), (entryType) => {
		if (!PI_SESSION_BOOTSTRAP_ENTRY_TYPES.has(entryType)) {
			hasNonBootstrap = true;
		}
	});
	return !hasNonBootstrap;
}

/**
 * Convert the bootstrap receipt into the executor plan without consulting the
 * current process state. The receipt is the pre-acceptance decision; runtime
 * may only verify that the retained tree still supports it.
 */
function treePlanFromPreparedStart(input: {
	preparedStart: PreparedTurnStart;
	turnDef: LlmTurnDefinition<string, unknown, unknown>;
	piHandle: PiTreeHandle;
	allowRetainedExecution?: boolean;
}): TurnTreePlan {
	const { preparedStart, turnDef, piHandle } = input;
	if (preparedStart.pathType !== turnDef.branchType) {
		throw new Error("Accepted tree plan path type no longer matches the selected turn");
	}
	if (preparedStart.contextMode !== turnDef.context) {
		throw new Error("Accepted tree plan context mode no longer matches the selected turn");
	}

	switch (preparedStart.startTarget.kind) {
		case "current_leaf":
			if (preparedStart.forkPiEntryId === null) {
				if (!input.allowRetainedExecution && !isPiTreeEmptyForPreparedEmptyPlan(piHandle)) {
					throw new Error("Accepted empty-tree plan no longer has an empty Pi tree");
				}
			} else if (
				!piHandle
					.getBranch(piHandle.getLeafId() ?? undefined)
					.some((entry) => entry.id === preparedStart.forkPiEntryId)
			) {
				throw new Error("Pi tree leaf no longer matches the accepted tree plan");
			}
			break;
		case "entry":
			if (
				preparedStart.forkPiEntryId !== preparedStart.startTarget.entryId ||
				!piHandle.getEntry(preparedStart.startTarget.entryId)
			) {
				throw new Error("Pi tree entry no longer matches the accepted tree plan");
			}
			break;
		case "root":
			if (preparedStart.forkPiEntryId !== null) {
				throw new Error("Accepted root tree plan must not retain a fork entry");
			}
			break;
	}

	return {
		pathType: preparedStart.pathType,
		forkPiEntryId: preparedStart.forkPiEntryId,
		savedPrimaryLeafId: piHandle.getLeafId(),
		restorePrimaryLeafAfterTurn: resolveLlmTurnRestorePrimaryLeafAfterTurn(turnDef),
		startTarget: preparedStart.startTarget,
	};
}

export async function executeLlmTurn<TOutcome extends string>(input: {
	resolvedWorkerProcess: ResolvedWorkerProcess;
	ctx: WorkerProcessContext;
	prepared?: unknown;
	piHandle: PiTreeHandle;
	turnDef: LlmTurnDefinition<TOutcome, unknown, unknown>;
	turnId: string;
	acceptedTurnRecordId: string | null;
	turnStartRecordId?: string | null;
	preparedTurnStart?: PreparedTurnStart | null;
	configSnapshot?: ConfigSnapshot;
	preTurnTargetedInputs?: readonly PreTurnTargetedInput[];
	scheduler: WorkerRuntimeScheduler;
	resultImageTools: ResultImageToolFactory;
	turnMaxDurationMs?: number;
	turnInactivityTimeoutMs?: number;
	turnAbortGracePeriodMs?: number;
	operatorAbortSignal?: AbortSignal;
	callbacks: LlmTurnExecutorCallbacks;
}): Promise<LlmTurnExecutionSuccess<TOutcome>> {
	const turnId = input.turnId;
	const trace = (payload: WorkerDiagnosticPayload) =>
		input.callbacks.emit?.({ kind: "trace", payload });
	const reportError = (payload: WorkerDiagnosticPayload) =>
		input.callbacks.emit?.({ kind: "error", payload });
	const taint = (reason: string) => input.callbacks.emit?.({ kind: "session_tainted", reason });
	const activePiHandle = input.piHandle;
	const turnType: ProcessTurnType = "llm";
	const rootEntryId = resolveRootEntryIdFromHandle(activePiHandle);
	const pathType: ProcessTurnRecordPathType = input.turnDef.branchType;
	const turnRecordId = resolveTurnRecordIdForExecution(
		input.ctx.process,
		turnId,
		input.acceptedTurnRecordId,
	);
	const turnStartRecordId = input.turnStartRecordId;
	const preTurnTargetedInputs = input.preTurnTargetedInputs ?? [];
	const continuationState = resolveTurnContinuationState({
		process: input.ctx.process,
		turnId,
		state: input.ctx.state,
	});
	const currentLeafIdBeforePlan = activePiHandle.getLeafId();
	const acceptedStartKickoff = turnStartRecordId
		? findIdentifiedPrompt(activePiHandle, {
				kind: "turn_prompt",
				startRecordId: turnStartRecordId,
				purpose: "kickoff",
			})
		: null;
	const hasActiveTurnResume =
		!continuationState &&
		acceptedStartKickoff !== null &&
		activePiHandle.isResumed &&
		currentLeafIdBeforePlan !== null &&
		input.ctx.process.selectedTurnId === turnId &&
		typeof input.acceptedTurnRecordId === "string" &&
		input.acceptedTurnRecordId.trim() !== "";
	const semanticEntryRefs = readProcessSemanticEntryRefs(input.ctx.state);
	const preTurnStartSelection = resolvePreTurnTargetStartSelection(preTurnTargetedInputs);
	if (
		input.acceptedTurnRecordId !== null &&
		input.acceptedTurnRecordId !== undefined &&
		turnStartRecordId &&
		!input.preparedTurnStart
	) {
		throw new TurnExecutionError(
			turnId,
			"infrastructure",
			`Accepted LLM turn '${turnId}' lacks its prepared tree start`,
		);
	}
	const preparedTreePlan = input.preparedTurnStart
		? treePlanFromPreparedStart({
				preparedStart: input.preparedTurnStart,
				turnDef: input.turnDef,
				piHandle: activePiHandle,
				allowRetainedExecution: hasActiveTurnResume,
			})
		: null;
	let treePlan: TurnTreePlan;
	if (hasActiveTurnResume) {
		const persistedPrimaryLeafId = semanticEntryRefs?.currentPrimaryPathLeaf?.entryId ?? null;
		treePlan = {
			// A replacement continues the already identified accepted kickoff. It
			// must not reposition to the original pre-kickoff target.
			pathType: input.turnDef.branchType,
			// Preserve the acceptance receipt's provenance in all lifecycle callbacks.
			// Only positioning changes for an in-flight replacement.
			forkPiEntryId: preparedTreePlan?.forkPiEntryId ?? currentLeafIdBeforePlan,
			savedPrimaryLeafId:
				input.turnDef.branchType === "primary"
					? null
					: persistedPrimaryLeafId && activePiHandle.getEntry(persistedPrimaryLeafId)
						? persistedPrimaryLeafId
						: currentLeafIdBeforePlan,
			restorePrimaryLeafAfterTurn: resolveLlmTurnRestorePrimaryLeafAfterTurn(input.turnDef),
			startTarget: { kind: "current_leaf" },
		};
	} else if (preparedTreePlan) {
		treePlan = {
			...preparedTreePlan,
			// Failed-turn continuation owns restoration of the pre-failure primary
			// path; receipt preparation remains authoritative for the start target.
			savedPrimaryLeafId:
				continuationState && input.turnDef.branchType !== "primary"
					? continuationState.savedPrimaryLeafId
					: preparedTreePlan.savedPrimaryLeafId,
		};
	} else if (continuationState) {
		treePlan = {
			pathType: input.turnDef.branchType,
			forkPiEntryId: continuationState.continueFromPiEntryId,
			savedPrimaryLeafId:
				input.turnDef.branchType === "primary" ? null : continuationState.savedPrimaryLeafId,
			restorePrimaryLeafAfterTurn: resolveLlmTurnRestorePrimaryLeafAfterTurn(input.turnDef),
			startTarget: {
				kind: "entry",
				entryId: continuationState.continueFromPiEntryId,
			},
		};
	} else {
		treePlan = planTurnTreeExecution({
			turnDef: input.turnDef,
			currentLeafId: currentLeafIdBeforePlan,
			rootEntryId,
			semanticEntryRefs,
			productRefs: readProcessProductRefs(input.ctx.state),
			entryExists: (entryId) => activePiHandle.getEntry(entryId) !== undefined,
			preTurnStartSelection,
			hasPreTurnTargetedInputs: preTurnTargetedInputs.length > 0,
		});
	}
	const initialPromptlessTurnResumeReason = resolvePromptlessTurnResumeReason({
		process: input.ctx.process,
		acceptedTurnRecordId: input.acceptedTurnRecordId,
		turnId,
		hasFailedTurnContinuation: continuationState !== null,
		preTurnTargetedInputs,
		piHandleIsResumed: hasActiveTurnResume,
		hasCurrentLeaf: activePiHandle.getLeafId() !== null,
	});
	const toolSession = createTurnOutcomeToolSession({
		turnId,
		turnRecordId,
		turnDef: input.turnDef,
		requestQuestions: input.callbacks.requestQuestions,
		integrationTools: input.callbacks.integrationTools,
		resultImageTool: input.resultImageTools.create({
			workspaceRoot: input.ctx.workspaceRoot,
			instanceId: input.ctx.process.id,
			turnRecordId,
		}),
	});
	const promptlessTargetedFollowUpGuidance =
		initialPromptlessTurnResumeReason === "targeted_follow_up"
			? buildPromptlessTargetedFollowUpGuidance({
					turnId,
					activeToolNames: toolSession.activeTools,
					promptSuffix: toolSession.addPromptSuffix(""),
				})
			: null;
	const preTurnTargetedInputsToApply = appendGuidanceToLastTargetedInput(
		preTurnTargetedInputs,
		promptlessTargetedFollowUpGuidance,
	);
	const reportFailedTurn = async (
		errorClass: WorkerErrorClass,
		message: string,
		resultPiEntryId: string | null,
		options: TurnFailureReportOptions = {},
	): Promise<never> => {
		const recoveryContext =
			options.recoveryContext !== undefined
				? options.recoveryContext
				: createGenericFailedTurnRecoveryContext();
		let failure = new TurnExecutionError(turnId, errorClass, message, {
			recoveryContext,
			failureCode: options.failureCode,
			failureDetails: options.failureDetails,
		});
		if (options.restorePrimaryLeaf ?? true) {
			try {
				await restoreHandleAfterTurn(activePiHandle, treePlan);
			} catch (restoreError: unknown) {
				reportError({
					level: "error",
					code: "turn.primary_leaf_restore_failed",
					message: `Failed to restore the primary path leaf after turn '${turnId}': ${toErrorMessage(restoreError)}`,
					turnRecordId,
					turnId,
					errorClass: "infrastructure",
				});
				failure = new TurnExecutionError(
					turnId,
					"infrastructure",
					`${message}. Failed to restore the primary path leaf: ${toErrorMessage(restoreError)}`,
					{ recoveryContext: null },
				);
			}
		}
		throw new TurnExecutionFailure({
			turnRecordId,
			turnId,
			turnType,
			pathType,
			failure,
			forkPiEntryId: treePlan.forkPiEntryId,
			resultPiEntryId,
		});
	};

	const failWithWorkerError = (
		code: string,
		errorClass: WorkerErrorClass,
		message: string,
		resultPiEntryId: string | null,
		options: TurnFailureReportOptions = {},
		details?: Record<string, unknown>,
	): Promise<never> => {
		reportError({
			level: "error",
			code,
			message,
			turnRecordId,
			turnId,
			errorClass,
			...(details ? { details } : {}),
		});
		return reportFailedTurn(errorClass, message, resultPiEntryId, options);
	};

	const failFromCaughtError = (
		code: string,
		error: unknown,
		currentLeafId: string | null,
		messagePrefix: string,
		options: { restorePrimaryLeaf?: boolean } = {},
	): Promise<never> => {
		const failure = buildTurnFailureReport(error, { turnId, currentLeafId, messagePrefix });
		if (failure.taintReason) {
			taint(failure.taintReason);
		}
		return failWithWorkerError(
			code,
			failure.errorClass,
			failure.message,
			failure.resultPiEntryId,
			options.restorePrimaryLeaf === undefined
				? (failure.options ?? {})
				: { ...(failure.options ?? {}), restorePrimaryLeaf: options.restorePrimaryLeaf },
			failure.details,
		);
	};

	let promptText: string | null = null;
	if (
		initialPromptlessTurnResumeReason === null ||
		initialPromptlessTurnResumeReason === "active_turn_resume"
	) {
		try {
			promptText = await input.turnDef.prompt({ ...input.ctx, prepared: input.prepared });
		} catch (error: unknown) {
			return failWithWorkerError(
				"turn.prompt_preparation_failed",
				"infrastructure",
				`Turn '${turnId}' prompt preparation failed: ${toErrorMessage(error)}`,
				null,
				{ restorePrimaryLeaf: false },
			);
		}
	}

	const prePositionLeafId = activePiHandle.getLeafId();
	try {
		await positionHandleForTurn(activePiHandle, treePlan);
	} catch (error: unknown) {
		return failFromCaughtError(
			"turn.position_failed",
			error,
			prePositionLeafId,
			`Turn '${turnId}' failed to position the instance tree`,
		);
	}
	if (!continuationState && input.turnDef.context === "compacted") {
		if (!turnStartRecordId) {
			return reportFailedTurn(
				"infrastructure",
				`Turn '${turnId}' requested compacted context without an accepted start identity`,
				activePiHandle.getLeafId(),
				{ restorePrimaryLeaf: false },
			);
		}
		try {
			const expectedParentId = hasActiveTurnResume
				? (preparedTreePlan?.forkPiEntryId ?? null)
				: activePiHandle.getLeafId();
			await ensureIdentifiedCompaction({
				piHandle: activePiHandle,
				identity: { kind: "turn_compaction", startRecordId: turnStartRecordId },
				expectedParentId,
				allowDescendantParent:
					hasActiveTurnResume && preparedTreePlan?.startTarget.kind === "current_leaf",
				requireOnCurrentBranch: hasActiveTurnResume,
				reuseWithoutBranching: hasActiveTurnResume,
			});
			trace({
				level: "info",
				code: "turn.context_compacted",
				message: `Turn '${turnId}' compacted the selected Pi context before prompting`,
				turnRecordId,
				turnId,
				details: { resultPiEntryId: activePiHandle.getLeafId() },
			});
		} catch (error: unknown) {
			return failFromCaughtError(
				"turn.context_compaction_failed",
				error,
				activePiHandle.getLeafId(),
				`Turn '${turnId}' failed to compact the selected Pi context`,
			);
		}
	}
	if (preTurnTargetedInputs.length > 0) {
		const semanticEntryRefs = readProcessSemanticEntryRefs(input.ctx.state);
		const productRefs = readProcessProductRefs(input.ctx.state);
		const targetValidationError = validatePreTurnTargetedInputs({
			turnId,
			inputs: preTurnTargetedInputs,
			treePlan: hasActiveTurnResume ? (preparedTreePlan ?? treePlan) : treePlan,
			semanticEntryRefs,
			productRefs,
			currentLeafId: prePositionLeafId,
			rootEntryId,
			entryExists: (entryId) => activePiHandle.getEntry(entryId) !== undefined,
		});
		if (targetValidationError) {
			return reportFailedTurn("infrastructure", targetValidationError, activePiHandle.getLeafId());
		}
		try {
			await applyPreTurnTargetedInputs({
				piHandle: activePiHandle,
				inputs: preTurnTargetedInputsToApply,
				pathType,
				...(hasActiveTurnResume
					? {
							recoveryBaseEntryId: preparedTreePlan?.forkPiEntryId ?? null,
							reuseExistingWithoutBranching: true,
							requireExisting: true,
						}
					: {}),
				onApplied: input.callbacks.onPreTurnTargetedInputApplied,
			});
		} catch (error: unknown) {
			return failFromCaughtError(
				"turn.targeted_input_apply_failed",
				error,
				activePiHandle.getLeafId(),
				`Turn '${turnId}' failed to apply a queued targeted input`,
			);
		}
	}
	if (
		(initialPromptlessTurnResumeReason === null ||
			initialPromptlessTurnResumeReason === "active_turn_resume") &&
		promptText !== null
	) {
		promptText = toolSession.addPromptSuffix(promptText);
	}
	if (
		initialPromptlessTurnResumeReason === "active_turn_resume" &&
		turnStartRecordId &&
		promptText !== null
	) {
		validateIdentifiedPrompt({
			piHandle: activePiHandle,
			identity: {
				kind: "turn_prompt",
				startRecordId: turnStartRecordId,
				purpose: "kickoff",
			},
			content: promptText,
			expectedParentId:
				input.turnDef.context === "compacted"
					? (findIdentifiedPrompt(activePiHandle, {
							kind: "turn_compaction",
							startRecordId: turnStartRecordId,
						})?.id ?? null)
					: (preparedTreePlan?.forkPiEntryId ?? null),
			allowDescendantParent: hasActiveTurnResume,
			requireOnCurrentBranch: true,
		});
	}

	const executeLogicalPromptPlan = (
		plan: LogicalTurnPromptPlan,
		options: { baseState?: ToolCompletionSnapshot<TOutcome> } = {},
	) =>
		runLogicalPromptPlan({
			plan,
			baseState: options.baseState,
			turnId,
			turnRecordId,
			piHandle: activePiHandle,
			turnDef: input.turnDef,
			toolSession,
			scheduler: input.scheduler,
			turnMaxDurationMs: input.turnMaxDurationMs,
			turnInactivityTimeoutMs: input.turnInactivityTimeoutMs,
			turnAbortGracePeriodMs: input.turnAbortGracePeriodMs,
			operatorAbortSignal: input.operatorAbortSignal,
			emit: input.callbacks.emit,
			reportFailedTurn,
		});

	const initialPromptPlan: LogicalTurnPromptPlan =
		initialPromptlessTurnResumeReason === null
			? turnStartRecordId
				? {
						kind: "continue",
						continueUserPrompt: promptText ?? "",
						identifiedPrompt: {
							kind: "turn_prompt",
							startRecordId: turnStartRecordId,
							purpose: "kickoff",
						},
					}
				: { kind: "prompt", promptText: promptText ?? "" }
			: {
					kind: "continue",
					continueUserPrompt:
						initialPromptlessTurnResumeReason === "targeted_follow_up"
							? null
							: initialPromptlessTurnResumeReason === "failed_turn_continue"
								? (continuationState?.continuePrompt ?? DEFAULT_CONTINUE_PROMPT)
								: DEFAULT_CONTINUE_PROMPT,
					...(turnStartRecordId && initialPromptlessTurnResumeReason === "failed_turn_continue"
						? {
								identifiedPrompt: {
									kind: "turn_prompt" as const,
									startRecordId: turnStartRecordId,
									purpose: "continue" as const,
								},
							}
						: {}),
				};
	const initialAttempt = await executeLogicalPromptPlan(initialPromptPlan);
	const recoveryResult = await runMissingToolRecovery({
		turnId,
		turnRecordId,
		piHandle: activePiHandle,
		initialAttempt,
		toolSession,
		emit: input.callbacks.emit,
		executeLogicalPromptPlan,
	});
	const finalCompletionState = recoveryResult.finalAttempt.completionState;
	const finalPromptResult = recoveryResult.finalAttempt.promptResult;
	const finalResolvedOutcome = recoveryResult.finalAttempt.resolvedOutcome;
	if (!recoveryResult.recovered) {
		return reportFailedTurn(
			"protocol_error",
			`Turn '${turnId}' completed without the required tool calls after ${MAX_MISSING_TOOL_CALL_RECOVERY_ATTEMPTS} automatic recovery attempts: ${recoveryResult.baseMissingToolRecoveryDescription}`,
			finalPromptResult.resultEntryId,
			{
				recoveryContext: recoveryResult.recoveryContext,
				restorePrimaryLeaf:
					recoveryResult.recoveryContext?.failureCode !== "missing_markdown_result",
			},
		);
	}
	if (finalResolvedOutcome === null) {
		return failWithWorkerError(
			"turn.outcome_missing",
			"protocol_error",
			toolSession.usesOutcomeTools
				? `Turn '${turnId}' completed without calling an outcome tool`
				: `Turn '${turnId}' completed without a turnEnd`,
			finalPromptResult.resultEntryId,
		);
	}

	const finalizedTurnResultMarkdown = toolSession.finalizeMarkdown(
		finalCompletionState,
		finalPromptResult.assistantMarkdown,
	);
	if (finalizedTurnResultMarkdown.errorMessage) {
		return failWithWorkerError(
			"turn.result_markdown_missing",
			"protocol_error",
			`Turn '${turnId}' completed without publishing a valid markdown result: ${finalizedTurnResultMarkdown.errorMessage}`,
			finalPromptResult.resultEntryId,
			{ restorePrimaryLeaf: false },
		);
	}

	try {
		await restoreHandleAfterTurn(activePiHandle, treePlan);
	} catch (error: unknown) {
		return failFromCaughtError(
			"turn.primary_leaf_restore_failed",
			error,
			finalPromptResult.resultEntryId,
			`Turn '${turnId}' completed but failed to restore the primary path leaf`,
			{ restorePrimaryLeaf: false },
		);
	}
	const rootEntryIdAfterTurn = resolveRootEntryIdFromHandle(activePiHandle);
	return {
		turnResult: finalResolvedOutcome,
		meta: {
			turnRecordId,
			turnType,
			pathType,
			forkPiEntryId: treePlan.forkPiEntryId,
			resultPiEntryId: finalPromptResult.resultEntryId,
			turnResultMarkdown: finalizedTurnResultMarkdown.markdown,
			rootEntryId: rootEntryIdAfterTurn,
		},
	};
}
