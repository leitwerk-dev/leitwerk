import { normalizeStringArray, trimToNull } from "./string-normalize.js";

export const DEFAULT_CONTINUE_PROMPT = "continue";

export const FAILED_TURN_RECOVERY_CODES = [
	"generic_continue",
	"missing_outcome_tool",
	"missing_markdown_result",
	"missing_required_tool_calls",
] as const;

export type FailedTurnRecoveryCode = (typeof FAILED_TURN_RECOVERY_CODES)[number];

export interface FailedTurnRecoveryContext {
	strategy: "continue";
	suggestedContinuePrompt: string;
	failureCode: FailedTurnRecoveryCode;
	missingToolNames?: string[];
}

export type FailedTurnRecoveryOverrides = Partial<Omit<FailedTurnRecoveryContext, "strategy">>;

export const FAILED_TURN_RECOVERY_METADATA_KEY = "failedTurnRecovery";
export const CONTINUE_PROMPT_METADATA_KEY = "continuePrompt";

export function isFailedTurnRecoveryCode(value: string): value is FailedTurnRecoveryCode {
	return (FAILED_TURN_RECOVERY_CODES as readonly string[]).includes(value);
}

function normalizeUniqueStringArray(value: unknown): string[] | undefined {
	const normalized = normalizeStringArray(value);
	return normalized.length > 0 ? [...new Set(normalized)] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeContinuePrompt(value: unknown): string | null {
	return trimToNull(value);
}

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

export function buildFailedTurnRecoveryMetadata(
	turnRecordId: string,
	context: FailedTurnRecoveryOverrides = {},
) {
	return {
		[FAILED_TURN_RECOVERY_METADATA_KEY]: {
			turnRecordId,
			...createGenericFailedTurnRecoveryContext(context),
		},
	};
}

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
	const suggestedContinuePrompt = normalizeContinuePrompt(raw.suggestedContinuePrompt);
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
