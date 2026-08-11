import {
	type ProcessSemanticEntryRefs,
	type ProcessStateJsonParseContext,
	parseProcessStateJsonStrict,
	parseSemanticEntryRefsStrict,
} from "@leitwerk-dev/domain";

export type ParsedProcessSemanticEntryRefs = ProcessSemanticEntryRefs;
export type ProcessStateJsonContext = ProcessStateJsonParseContext;

export const parseProcessStateJsonRecord = parseProcessStateJsonStrict;

export function parseSemanticEntryRefsFromStateRecord(
	stateRecord: Record<string, unknown>,
	context?: ProcessStateJsonContext,
): ParsedProcessSemanticEntryRefs {
	return parseSemanticEntryRefsStrict(stateRecord.semanticEntryRefs, context);
}
