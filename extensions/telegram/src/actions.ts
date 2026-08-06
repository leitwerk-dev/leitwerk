import { type ProcessInstance, readFailedTurnRecoveryContext } from "@leitwerk-dev/domain";
import type { ProcessActionSummaryLike } from "@leitwerk-dev/process-sdk";
import type { TelegramInlineKeyboard } from "./types.js";

const CALLBACKS = {
	retry: "r",
	continue: "c",
} as const;

function rows<T>(items: readonly T[], size: number): T[][] {
	return Array.from({ length: Math.ceil(items.length / size) }, (_, index) => [
		...items.slice(index * size, index * size + size),
	]);
}

export function continuableFailedTurnRecordId(process: ProcessInstance): string | null {
	const turnRecordId =
		process.lifecycleStatus === "error" && process.currentExecution?.kind === "server_turn"
			? process.currentExecution.id
			: null;
	return turnRecordId && readFailedTurnRecoveryContext(process.metadata, turnRecordId)
		? turnRecordId
		: null;
}

export function buildActionKeyboard(input: {
	process: ProcessInstance;
	actions: readonly ProcessActionSummaryLike[];
}): TelegramInlineKeyboard | undefined {
	const buttons = input.actions.map((action) => ({
		text: action.label,
		callbackData: `a:${input.process.id}:${action.id}`,
	}));
	if (input.process.lifecycleStatus === "error" && input.process.currentExecution) {
		buttons.push({ text: "Retry", callbackData: `${CALLBACKS.retry}:${input.process.id}` });
		if (continuableFailedTurnRecordId(input.process)) {
			buttons.push({ text: "Continue", callbackData: `${CALLBACKS.continue}:${input.process.id}` });
		}
	}
	return buttons.length ? { inlineKeyboard: rows(buttons, 2) } : undefined;
}
