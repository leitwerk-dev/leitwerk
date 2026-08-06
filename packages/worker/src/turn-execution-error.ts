import type {
	FailedTurnRecoveryContext,
	TurnFailureCode,
	WorkerErrorClass,
} from "@leitwerk-dev/domain";
import { isWorkerErrorClass } from "@leitwerk-dev/domain";
import { isPiBranchDriftError } from "./pi-branch-guard.js";

export type TurnFailureReportOptions = {
	recoveryContext?: FailedTurnRecoveryContext | null;
	restorePrimaryLeaf?: boolean;
	failureCode?: TurnFailureCode | null;
	failureDetails?: Record<string, unknown> | null;
};

export class TurnExecutionError extends Error {
	readonly errorClass: WorkerErrorClass;
	readonly turnId: string;
	readonly failureCode: TurnFailureCode | null;
	readonly failureDetails: Record<string, unknown> | null;
	readonly recoveryContext: FailedTurnRecoveryContext | null;

	constructor(
		turnId: string,
		errorClass: WorkerErrorClass,
		message: string,
		options: Omit<TurnFailureReportOptions, "restorePrimaryLeaf"> = {},
	) {
		super(message);
		this.name = "TurnExecutionError";
		this.turnId = turnId;
		this.errorClass = errorClass;
		this.failureCode = options.failureCode ?? null;
		this.failureDetails = options.failureDetails ?? null;
		this.recoveryContext = options.recoveryContext ?? null;
	}
}

export function classifyRuntimeError(
	error: unknown,
	fallbackErrorClass: WorkerErrorClass = "infrastructure",
): {
	errorClass: WorkerErrorClass;
	message: string;
} {
	if (error instanceof TurnExecutionError) {
		return { errorClass: error.errorClass, message: error.message };
	}
	if (
		typeof error === "object" &&
		error !== null &&
		"errorClass" in error &&
		isWorkerErrorClass(String((error as { errorClass?: unknown }).errorClass))
	) {
		const customError = error as { errorClass: WorkerErrorClass; message?: unknown };
		return {
			errorClass: customError.errorClass,
			message:
				typeof customError.message === "string" && customError.message.trim() !== ""
					? customError.message
					: String(error),
		};
	}
	if (error instanceof Error && error.message.trim() !== "") {
		return { errorClass: fallbackErrorClass, message: error.message };
	}
	return { errorClass: fallbackErrorClass, message: String(error) };
}

export function buildTurnFailureReport(
	error: unknown,
	input: {
		turnId: string;
		currentLeafId: string | null;
		fallbackErrorClass?: WorkerErrorClass;
		messagePrefix?: string;
	},
) {
	const classified = classifyRuntimeError(error, input.fallbackErrorClass);
	const branchDrift = isPiBranchDriftError(error) ? error : null;
	return {
		errorClass: classified.errorClass,
		message: input.messagePrefix
			? `${input.messagePrefix}: ${classified.message}`
			: classified.message,
		resultPiEntryId: branchDrift ? null : input.currentLeafId,
		...(branchDrift
			? {
					details: branchDrift.failureDetails,
					options: branchDrift.toTurnFailureOptions(),
					taintReason: `branch_drift:${input.turnId}`,
				}
			: {}),
	};
}

export function toErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message.trim() !== "") {
		return error.message;
	}
	return String(error);
}
