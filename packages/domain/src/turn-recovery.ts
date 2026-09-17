import { normalizeStringArray, trimToNull } from "./string-normalize.js";
import { isUnknownRecord as isRecord } from "./unknown-record.js";

/** @internal */
export const DEFAULT_CONTINUE_PROMPT = "continue";

/** @internal */
export const FAILED_TURN_RECOVERY_CODES = [
	"generic_continue",
	"missing_outcome_tool",
	"missing_markdown_result",
	"missing_required_tool_calls",
] as const;

/** @internal */
export type FailedTurnRecoveryCode = (typeof FAILED_TURN_RECOVERY_CODES)[number];

/** @internal */
export interface FailedTurnRecoveryContext {
	/** @internal */
	strategy: "continue";
	/** @internal */
	suggestedContinuePrompt: string;
	/** @internal */
	failureCode: FailedTurnRecoveryCode;
	/** @internal */
	missingToolNames?: string[];
}

/** @internal */
export type FailedTurnRecoveryOverrides = Partial<Omit<FailedTurnRecoveryContext, "strategy">>;

/** @internal */
export const FAILED_TURN_RECOVERY_METADATA_KEY = "failedTurnRecovery";
/** @internal */
export const CONTINUE_PROMPT_METADATA_KEY = "continuePrompt";
const TERMINAL_OUTCOME_RECORDING_FAILURE_PREFIX =
	"Server could not durably record worker turn outcome:";

/** @internal */
export function isFailedTurnRecoveryCode(value: string): value is FailedTurnRecoveryCode {
	return (FAILED_TURN_RECOVERY_CODES as readonly string[]).includes(value);
}

function normalizeUniqueStringArray(value: unknown): string[] | undefined {
	const normalized = normalizeStringArray(value);
	return normalized.length > 0 ? [...new Set(normalized)] : undefined;
}

export { trimToNull as normalizeContinuePrompt };

/** @internal */
export function createGenericFailedTurnRecoveryContext(
	overrides: FailedTurnRecoveryOverrides = {},
): FailedTurnRecoveryContext {
	return {
		strategy: "continue",
		suggestedContinuePrompt: DEFAULT_CONTINUE_PROMPT,
		failureCode: "generic_continue",
		...overrides,
	};
}

/** @internal */
export function inferTerminalRecordingFailedTurnRecoveryContext(input: {
	/** @internal */
	errorSummary?: string | null;
	/** @internal */
	errorClass?: string | null;
}): FailedTurnRecoveryContext | null {
	if (
		input.errorClass !== "infrastructure" ||
		!input.errorSummary?.startsWith(TERMINAL_OUTCOME_RECORDING_FAILURE_PREFIX)
	) {
		return null;
	}
	return createGenericFailedTurnRecoveryContext();
}

/** @internal */
export function buildFailedTurnRecoveryMetadata(
	turnRecordId: string,
	context: FailedTurnRecoveryOverrides = {},
) {
	return {
		/** @internal */
		[FAILED_TURN_RECOVERY_METADATA_KEY]: {
			/** @internal */
			turnRecordId,
			...createGenericFailedTurnRecoveryContext(context),
		},
	};
}

/** @internal */
export function readFailedTurnRecoveryContext(
	metadata: Record<string, unknown> | null | undefined,
	expectedTurnRecordId?: string | null,
): FailedTurnRecoveryContext | null {
	if (!metadata) {
		return null;
	}
	const raw = metadata[FAILED_TURN_RECOVERY_METADATA_KEY];
	if (!isRecord(raw)) {
		return null;
	}
	if (expectedTurnRecordId) {
		const turnRecordId = trimToNull(raw.turnRecordId);
		if (turnRecordId !== expectedTurnRecordId) {
			return null;
		}
	}
	if (raw.strategy !== "continue") {
		return null;
	}
	const suggestedContinuePrompt = trimToNull(raw.suggestedContinuePrompt);
	const failureCode = trimToNull(raw.failureCode);
	if (!suggestedContinuePrompt || !failureCode || !isFailedTurnRecoveryCode(failureCode)) {
		return null;
	}
	const missingToolNames = normalizeUniqueStringArray(raw.missingToolNames);
	return {
		strategy: "continue",
		suggestedContinuePrompt,
		failureCode,
		...(missingToolNames ? { missingToolNames } : {}),
	};
}
