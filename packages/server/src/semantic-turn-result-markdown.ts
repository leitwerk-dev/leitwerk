import type {
	ProcessInstance,
	ProcessSemanticEntryRefKey,
	ProcessTurnRecord,
	TurnStartRecord,
} from "@leitwerk-dev/domain";
import {
	parseProcessStateJsonRecord,
	parseSemanticEntryRefsFromStateRecord,
} from "./semantic-state-json.js";

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

export function parseProcessSemanticRefsFromStateJson(
	stateJson: string | null | undefined,
	instanceId: string,
) {
	const parsed = parseProcessStateJsonRecord(stateJson, { processId: instanceId });
	return parseSemanticEntryRefsFromStateRecord(parsed, { processId: instanceId });
}

function normalizeTurnResultMarkdown(value: string | null | undefined): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed === "" ? null : trimmed;
}

export function resolveSemanticTurnResultMarkdown(input: {
	process: Pick<ProcessInstance, "id" | "selectedTurnId" | "stateJson">;
	semanticEntryRefKey: ProcessSemanticEntryRefKey;
	turnRecords: TurnRecordMarkdownLookup;
	required: boolean;
}): string | null {
	const { process, semanticEntryRefKey, turnRecords, required } = input;
	const selectedTurnId = process.selectedTurnId ?? "null";
	const semanticRef = parseProcessSemanticRefsFromStateJson(process.stateJson, process.id)[
		semanticEntryRefKey
	];
	if (!semanticRef) {
		if (!required) {
			return null;
		}
		throw new Error(
			`Invalid process state for process '${process.id}': turn '${selectedTurnId}' requires semantic ref '${semanticEntryRefKey}'`,
		);
	}
	if (!semanticRef.turnRecordId) {
		throw new Error(
			`Invalid process state for process '${process.id}': semantic ref '${semanticEntryRefKey}' for turn '${selectedTurnId}' does not reference a turn record`,
		);
	}
	const turnRecord = turnRecords.getById(semanticRef.turnRecordId);
	if (!turnRecord) {
		throw new Error(
			`Invalid process state for process '${process.id}': semantic ref '${semanticEntryRefKey}' for turn '${selectedTurnId}' references missing turn record '${semanticRef.turnRecordId}'`,
		);
	}
	if (turnRecord.instanceId !== process.id) {
		throw new Error(
			`Invalid process state for process '${process.id}': semantic ref '${semanticEntryRefKey}' for turn '${selectedTurnId}' references turn record '${semanticRef.turnRecordId}' from process '${turnRecord.instanceId}'`,
		);
	}
	if (!turnRecord.resultPiEntryId || turnRecord.resultPiEntryId !== semanticRef.entryId) {
		throw new Error(
			`Invalid process state for process '${process.id}': semantic ref '${semanticEntryRefKey}' for turn '${selectedTurnId}' points at entry '${semanticRef.entryId}' but turn record '${semanticRef.turnRecordId}' resolved '${turnRecord.resultPiEntryId ?? "null"}'`,
		);
	}
	const markdown = normalizeTurnResultMarkdown(turnRecord.turnResultMarkdown);
	if (!markdown) {
		if (!required) {
			return null;
		}
		throw new Error(
			`Invalid process state for process '${process.id}': semantic ref '${semanticEntryRefKey}' for turn '${selectedTurnId}' requires non-empty turn-result markdown on turn record '${semanticRef.turnRecordId}'`,
		);
	}
	return markdown;
}
