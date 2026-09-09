import {
	assertValidProcessProductName,
	type ProcessInstance,
	type ProcessSemanticEntryRefKey,
	type ProcessTurnRecord,
	parseProductRefsFromStateJsonStrict,
	parseSemanticEntryRefsFromStateJsonStrict,
	type SemanticEntryRef,
	type TurnStartRecord,
} from "@leitwerk-dev/domain";

export interface TurnRecordMarkdownLookup {
	getById(
		id: string,
	): Pick<ProcessTurnRecord, "instanceId" | "resultPiEntryId" | "turnResultMarkdown"> | null;
}

export interface ProcessTurnRecordLookup {
	getById(id: string): ProcessTurnRecord | null;
	listByInstance(instanceId: string): readonly ProcessTurnRecord[];
}

export interface TurnStartRecordLookup {
	getById(id: string): TurnStartRecord | null;
}

interface TurnResultMarkdownInput {
	process: Pick<ProcessInstance, "id" | "selectedTurnId" | "stateJson">;
	turnRecords: TurnRecordMarkdownLookup;
	required: boolean;
}

export function resolveProductTurnResultMarkdown(
	input: TurnResultMarkdownInput & { productName: string },
): string | null {
	const { process, productName } = input;
	assertValidProcessProductName(productName);
	const ref = parseProductRefsFromStateJsonStrict(process.stateJson, {
		processId: process.id,
	})[productName];
	return resolveTurnResultMarkdown(input, ref, `product '${productName}'`);
}

export function resolveSemanticTurnResultMarkdown(
	input: TurnResultMarkdownInput & { semanticEntryRefKey: ProcessSemanticEntryRefKey },
): string | null {
	const { process, semanticEntryRefKey } = input;
	const ref = parseSemanticEntryRefsFromStateJsonStrict(process.stateJson, {
		processId: process.id,
	})[semanticEntryRefKey];
	return resolveTurnResultMarkdown(input, ref, `semantic ref '${semanticEntryRefKey}'`);
}

function resolveTurnResultMarkdown(
	{ process, turnRecords, required }: TurnResultMarkdownInput,
	ref: SemanticEntryRef | null | undefined,
	referenceLabel: string,
): string | null {
	const selectedTurnId = process.selectedTurnId ?? "null";
	if (!ref) {
		if (!required) {
			return null;
		}
		throw new Error(
			`Invalid process state for process '${process.id}': turn '${selectedTurnId}' requires ${referenceLabel}`,
		);
	}
	if (!ref.turnRecordId) {
		throw new Error(
			`Invalid process state for process '${process.id}': ${referenceLabel} for turn '${selectedTurnId}' does not reference a turn record`,
		);
	}
	const turnRecord = turnRecords.getById(ref.turnRecordId);
	if (!turnRecord) {
		throw new Error(
			`Invalid process state for process '${process.id}': ${referenceLabel} for turn '${selectedTurnId}' references missing turn record '${ref.turnRecordId}'`,
		);
	}
	if (turnRecord.instanceId !== process.id) {
		throw new Error(
			`Invalid process state for process '${process.id}': ${referenceLabel} for turn '${selectedTurnId}' references turn record '${ref.turnRecordId}' from process '${turnRecord.instanceId}'`,
		);
	}
	if (!turnRecord.resultPiEntryId || turnRecord.resultPiEntryId !== ref.entryId) {
		throw new Error(
			`Invalid process state for process '${process.id}': ${referenceLabel} for turn '${selectedTurnId}' points at entry '${ref.entryId}' but turn record '${ref.turnRecordId}' resolved '${turnRecord.resultPiEntryId ?? "null"}'`,
		);
	}
	const markdown =
		(typeof turnRecord.turnResultMarkdown === "string"
			? turnRecord.turnResultMarkdown.trim()
			: "") || null;
	if (!markdown) {
		if (!required) {
			return null;
		}
		throw new Error(
			`Invalid process state for process '${process.id}': ${referenceLabel} for turn '${selectedTurnId}' requires non-empty turn-result markdown on turn record '${ref.turnRecordId}'`,
		);
	}
	return markdown;
}
