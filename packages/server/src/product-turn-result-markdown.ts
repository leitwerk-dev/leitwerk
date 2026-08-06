import type { ProcessInstance, ProcessTurnRecord } from "@leitwerk-dev/domain";
import {
	assertValidProcessProductName,
	parseProductRefsFromStateJsonStrict,
} from "@leitwerk-dev/domain";
import type { TurnRecordMarkdownLookup } from "./semantic-turn-result-markdown.js";

function normalizeTurnResultMarkdown(value: string | null | undefined): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed === "" ? null : trimmed;
}

export function resolveProductTurnResultMarkdown(input: {
	process: Pick<ProcessInstance, "id" | "selectedTurnId" | "stateJson">;
	productName: string;
	turnRecords: TurnRecordMarkdownLookup;
	required: boolean;
}): string | null {
	const { process, productName, turnRecords, required } = input;
	assertValidProcessProductName(productName);
	const selectedTurnId = process.selectedTurnId ?? "null";
	const productRef = parseProductRefsFromStateJsonStrict(process.stateJson, {
		processId: process.id,
	})[productName];
	if (!productRef) {
		if (!required) {
			return null;
		}
		throw new Error(
			`Invalid process state for process '${process.id}': turn '${selectedTurnId}' requires product '${productName}'`,
		);
	}
	if (!productRef.turnRecordId) {
		throw new Error(
			`Invalid process state for process '${process.id}': product '${productName}' for turn '${selectedTurnId}' does not reference a turn record`,
		);
	}
	const turnRecord: Pick<
		ProcessTurnRecord,
		"instanceId" | "resultPiEntryId" | "turnResultMarkdown"
	> | null = turnRecords.getById(productRef.turnRecordId);
	if (!turnRecord) {
		throw new Error(
			`Invalid process state for process '${process.id}': product '${productName}' for turn '${selectedTurnId}' references missing turn record '${productRef.turnRecordId}'`,
		);
	}
	if (turnRecord.instanceId !== process.id) {
		throw new Error(
			`Invalid process state for process '${process.id}': product '${productName}' for turn '${selectedTurnId}' references turn record '${productRef.turnRecordId}' from process '${turnRecord.instanceId}'`,
		);
	}
	if (!turnRecord.resultPiEntryId || turnRecord.resultPiEntryId !== productRef.entryId) {
		throw new Error(
			`Invalid process state for process '${process.id}': product '${productName}' for turn '${selectedTurnId}' points at entry '${productRef.entryId}' but turn record '${productRef.turnRecordId}' resolved '${turnRecord.resultPiEntryId ?? "null"}'`,
		);
	}
	const markdown = normalizeTurnResultMarkdown(turnRecord.turnResultMarkdown);
	if (!markdown) {
		if (!required) {
			return null;
		}
		throw new Error(
			`Invalid process state for process '${process.id}': product '${productName}' for turn '${selectedTurnId}' requires non-empty turn-result markdown on turn record '${productRef.turnRecordId}'`,
		);
	}
	return markdown;
}
