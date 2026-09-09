import type { WorkerErrorClass } from "@leitwerk-dev/domain";
import type { WorkerDiagnosticPayload, WorkerOperationEmitter } from "./diagnostics.js";
import {
	doesPiEventResetInactivity,
	type PiTreeHandle,
	type PiTurnExecutionResult,
} from "./pi-adapter.js";
import { toErrorMessage } from "./turn-execution-error.js";

export type PromptGuardTimer = ReturnType<typeof setTimeout>;

export interface PromptGuardScheduler {
	setTimeout(handler: () => void, delayMs: number): PromptGuardTimer;
	clearTimeout(timer: PromptGuardTimer): void;
	sleep(delayMs: number): Promise<void>;
	now(): Date;
}

export type PromptGuardTimeoutKind = "max_duration" | "inactivity";

/** Shared by custom tools and one prompt attempt to pause execution budgets safely. */
export class PromptGuardSuspension {
	private listener: ((paused: boolean) => void) | null = null;

	suspend(): () => void {
		this.listener?.(true);
		let suspended = true;
		return () => {
			if (!suspended) return;
			suspended = false;
			this.listener?.(false);
		};
	}

	subscribe(listener: (paused: boolean) => void): () => void {
		this.listener = listener;
		return () => {
			this.listener = null;
		};
	}
}

export class PromptTimeoutError extends Error {
	readonly timeoutKind: PromptGuardTimeoutKind;
	readonly timeoutMs: number;

	constructor(turnId: string, timeoutKind: PromptGuardTimeoutKind, timeoutMs: number) {
		super(
			timeoutKind === "inactivity"
				? `Turn '${turnId}' exceeded inactivity timeout after ${timeoutMs}ms without Pi activity`
				: `Turn '${turnId}' exceeded maximum duration of ${timeoutMs}ms`,
		);
		this.name = "PromptTimeoutError";
		this.timeoutKind = timeoutKind;
		this.timeoutMs = timeoutMs;
	}
}

/**
 * Raised when an operator explicitly stops the in-flight turn. Carries the
 * `operator_abort` error class so the parked failure reads as an intentional
 * stop (with continue / go-back recovery) rather than a model or infra failure.
 */
export class OperatorAbortError extends Error {
	readonly errorClass: WorkerErrorClass = "operator_abort";

	constructor(turnId: string) {
		super(
			`Stopped by operator. Continue from the saved work, or go back and choose a different action.`,
		);
		this.name = "OperatorAbortError";
		this.turnId = turnId;
	}

	readonly turnId: string;
}

export interface PromptGuardCallbacks {
	scheduler: PromptGuardScheduler;
	turnMaxDurationMs?: number;
	turnInactivityTimeoutMs?: number;
	turnAbortGracePeriodMs?: number;
	operatorAbortSignal?: AbortSignal;
	guardSuspension?: PromptGuardSuspension;
	emit?: WorkerOperationEmitter;
}

export interface PromptExecutionAttemptResult {
	result: PiTurnExecutionResult;
	sawCompaction: boolean;
}

export async function promptWithGuards(
	deps: PromptGuardCallbacks,
	input: {
		piHandle: Pick<PiTreeHandle, "subscribe" | "abortTurn">;
		turnRecordId: string;
		turnId: string;
		runPrompt: () => Promise<PiTurnExecutionResult>;
	},
): Promise<PromptExecutionAttemptResult> {
	const turnMaxDurationMs = deps.turnMaxDurationMs;
	const turnInactivityTimeoutMs = deps.turnInactivityTimeoutMs;
	const turnAbortGracePeriodMs = deps.turnAbortGracePeriodMs ?? 5_000;
	const trace = (payload: WorkerDiagnosticPayload) => deps.emit?.({ kind: "trace", payload });
	const reportError = (payload: WorkerDiagnosticPayload) => deps.emit?.({ kind: "error", payload });
	const taint = (reason: string) => deps.emit?.({ kind: "session_tainted", reason });
	const timeoutDetails = {
		...(turnMaxDurationMs && turnMaxDurationMs > 0 ? { turnMaxDurationMs } : {}),
		...(turnInactivityTimeoutMs && turnInactivityTimeoutMs > 0 ? { turnInactivityTimeoutMs } : {}),
	};
	trace({
		level: "info",
		code: "turn.prompt_started",
		message: `Turn '${input.turnId}' prompt started`,
		turnRecordId: input.turnRecordId,
		turnId: input.turnId,
		...(Object.keys(timeoutDetails).length > 0 ? { details: timeoutDetails } : {}),
	});

	let maxDurationTimer: PromptGuardTimer | null = null;
	let inactivityTimer: PromptGuardTimer | null = null;
	let rejectTimeout: ((error: Error) => void) | null = null;
	let abortReason: PromptGuardTimeoutKind | "operator_abort" | null = null;
	let sawCompaction = false;
	let removeOperatorAbortListener: (() => void) | null = null;
	let removeSuspensionListener: (() => void) | null = null;
	let guardsPaused = false;
	let maxDurationRemainingMs = turnMaxDurationMs ?? 0;
	let maxDurationArmedAt = 0;

	const clearTimers = () => {
		if (maxDurationTimer !== null) {
			deps.scheduler.clearTimeout(maxDurationTimer);
			maxDurationTimer = null;
		}
		if (inactivityTimer !== null) {
			deps.scheduler.clearTimeout(inactivityTimer);
			inactivityTimer = null;
		}
	};

	const abortWithinGracePeriod = async (timeoutKind?: PromptGuardTimeoutKind) => {
		let abortCompleted = false;
		try {
			await Promise.race([
				input.piHandle.abortTurn().then(() => {
					abortCompleted = true;
				}),
				deps.scheduler.sleep(turnAbortGracePeriodMs),
			]);
			if (!abortCompleted) {
				reportError({
					level: "error",
					code: "guard.abort_grace_elapsed",
					message: `${timeoutKind ? "Timed out" : "Operator-stopped"} turn '${input.turnId}' did not abort within ${turnAbortGracePeriodMs}ms`,
					turnRecordId: input.turnRecordId,
					turnId: input.turnId,
					errorClass: "infrastructure",
					details: { turnAbortGracePeriodMs, ...(timeoutKind ? { timeoutKind } : {}) },
				});
			}
		} catch (error) {
			reportError({
				level: "error",
				code: "guard.abort_failed",
				message: `Failed to abort ${timeoutKind ? "timed out" : "operator-stopped"} turn '${input.turnId}': ${toErrorMessage(error)}`,
				turnRecordId: input.turnRecordId,
				turnId: input.turnId,
				errorClass: "infrastructure",
				...(timeoutKind ? { details: { timeoutKind } } : {}),
			});
		}
	};

	const requestAbortForTimeout = (timeoutKind: PromptGuardTimeoutKind, timeoutMs: number) => {
		if (abortReason !== null) {
			return;
		}
		abortReason = timeoutKind;
		clearTimers();
		const error = new PromptTimeoutError(input.turnId, timeoutKind, timeoutMs);
		reportError({
			level: "error",
			code:
				timeoutKind === "inactivity"
					? "guard.turn_inactivity_timeout"
					: "guard.turn_max_duration_exceeded",
			message: error.message,
			turnRecordId: input.turnRecordId,
			turnId: input.turnId,
			errorClass: "llm_error" satisfies WorkerErrorClass,
			details: { timeoutMs, timeoutKind },
		});
		taint(`${timeoutKind}:${input.turnId}`);
		trace({
			level: "warn",
			code: "guard.abort_requested",
			message: `Requesting abort for turn '${input.turnId}' after ${timeoutKind}`,
			turnRecordId: input.turnRecordId,
			turnId: input.turnId,
			details: { turnAbortGracePeriodMs, timeoutMs, timeoutKind },
		});
		rejectTimeout?.(error);

		void abortWithinGracePeriod(timeoutKind);
	};

	const requestOperatorAbort = () => {
		if (abortReason !== null) {
			return;
		}
		abortReason = "operator_abort";
		clearTimers();
		const error = new OperatorAbortError(input.turnId);
		reportError({
			level: "error",
			code: "guard.operator_abort_requested",
			message: error.message,
			turnRecordId: input.turnRecordId,
			turnId: input.turnId,
			errorClass: "operator_abort" satisfies WorkerErrorClass,
		});
		taint(`operator_abort:${input.turnId}`);
		trace({
			level: "warn",
			code: "guard.abort_requested",
			message: `Requesting abort for turn '${input.turnId}' after operator stop`,
			turnRecordId: input.turnRecordId,
			turnId: input.turnId,
			details: { turnAbortGracePeriodMs },
		});
		rejectTimeout?.(error);

		void abortWithinGracePeriod();
	};

	const armMaxDurationTimer = () => {
		if (
			!turnMaxDurationMs ||
			turnMaxDurationMs <= 0 ||
			maxDurationRemainingMs <= 0 ||
			guardsPaused ||
			abortReason !== null
		)
			return;
		maxDurationArmedAt = deps.scheduler.now().getTime();
		maxDurationTimer = deps.scheduler.setTimeout(() => {
			requestAbortForTimeout("max_duration", turnMaxDurationMs);
		}, maxDurationRemainingMs);
	};

	const resetInactivityTimer = () => {
		if (
			!turnInactivityTimeoutMs ||
			turnInactivityTimeoutMs <= 0 ||
			guardsPaused ||
			abortReason !== null
		) {
			return;
		}
		if (inactivityTimer !== null) {
			deps.scheduler.clearTimeout(inactivityTimer);
		}
		inactivityTimer = deps.scheduler.setTimeout(() => {
			requestAbortForTimeout("inactivity", turnInactivityTimeoutMs);
		}, turnInactivityTimeoutMs);
	};

	const unsubscribe = input.piHandle.subscribe((event) => {
		if (event.type === "compaction.start" || event.type === "compaction.end") {
			sawCompaction = true;
		}
		if (doesPiEventResetInactivity(event)) {
			resetInactivityTimer();
		}
	});

	const operatorAbortSignal = deps.operatorAbortSignal;
	const guardPromise = new Promise<never>((_, reject) => {
		rejectTimeout = reject;
		armMaxDurationTimer();
		resetInactivityTimer();
	});
	removeSuspensionListener =
		deps.guardSuspension?.subscribe((paused) => {
			if (guardsPaused === paused || abortReason !== null) return;
			guardsPaused = paused;
			if (paused) {
				if (maxDurationTimer !== null) {
					maxDurationRemainingMs = Math.max(
						1,
						maxDurationRemainingMs -
							Math.max(0, deps.scheduler.now().getTime() - maxDurationArmedAt),
					);
				}
				clearTimers();
				trace({
					level: "info",
					code: "guard.suspended_for_operator",
					message: `Turn '${input.turnId}' execution budgets paused for operator input`,
					turnRecordId: input.turnRecordId,
					turnId: input.turnId,
				});
			} else {
				armMaxDurationTimer();
				resetInactivityTimer();
			}
		}) ?? null;

	// The executor above runs synchronously, so rejectTimeout is set by now.
	// Wire the operator abort listener here (not inside the executor) so the
	// removeOperatorAbortListener assignment stays in the main control flow.
	if (operatorAbortSignal) {
		if (operatorAbortSignal.aborted) {
			requestOperatorAbort();
		} else {
			const onAbort = () => requestOperatorAbort();
			operatorAbortSignal.addEventListener("abort", onAbort, { once: true });
			removeOperatorAbortListener = () => operatorAbortSignal.removeEventListener("abort", onAbort);
		}
	}

	const hasGuards =
		(turnMaxDurationMs !== undefined && turnMaxDurationMs > 0) ||
		(turnInactivityTimeoutMs !== undefined && turnInactivityTimeoutMs > 0) ||
		operatorAbortSignal !== undefined;

	try {
		if (abortReason === "operator_abort") {
			await guardPromise;
		}
		const result = !hasGuards
			? await input.runPrompt()
			: await Promise.race([input.runPrompt(), guardPromise]);
		trace({
			level: "info",
			code: "turn.prompt_completed",
			message: `Turn '${input.turnId}' prompt completed`,
			turnRecordId: input.turnRecordId,
			turnId: input.turnId,
			details: { resultPiEntryId: result.resultEntryId },
		});
		return {
			result,
			sawCompaction,
		};
	} finally {
		unsubscribe();
		clearTimers();
		removeOperatorAbortListener?.();
		removeSuspensionListener?.();
	}
}
