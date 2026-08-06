import type { EngineErrorCode, EngineFailureStage, ProcessEngineLogger } from "./types.js";

export type InternalEngineFailureCode = "operation_failed" | "record_failed" | "post_commit_failed";

export function isInternalEngineFailureCode(
	code: string | null | undefined,
): code is InternalEngineFailureCode {
	return code === "operation_failed" || code === "record_failed" || code === "post_commit_failed";
}

export function publicInternalEngineFailureMessage(
	code: string,
	stage?: EngineFailureStage,
): string {
	switch (code) {
		case "operation_failed":
			return "Process operation failed before commit";
		case "record_failed":
			return "Process operation failed during durable recording";
		case "post_commit_failed":
			return stage === "pre_commit"
				? "Process operation failed before commit"
				: "Process operation failed after commit";
		default:
			return "Process operation failed";
	}
}

export function publicEngineFailureMessage(input: {
	code: string;
	message: string;
	stage?: EngineFailureStage;
}): string {
	return isInternalEngineFailureCode(input.code)
		? publicInternalEngineFailureMessage(input.code, input.stage)
		: input.message;
}

export function logProcessEngineError(
	logger: ProcessEngineLogger | undefined,
	input: {
		err: unknown;
		operationKind: string;
		instanceId: string;
		stage: EngineFailureStage;
		code: EngineErrorCode;
	},
): void {
	logger?.error(
		{
			err: input.err,
			operationKind: input.operationKind,
			instanceId: input.instanceId,
			stage: input.stage,
			code: input.code,
		},
		"ProcessEngine operation failed",
	);
}
