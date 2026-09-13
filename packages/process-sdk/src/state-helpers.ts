import {
	asUnknownRecord,
	createEmptyProcessProductRefs,
	createEmptyProcessSemanticEntryRefs,
	type ProcessProductRefs,
	type ProcessSemanticEntryRefs,
	parseProcessProductRefs,
	parseProcessSemanticEntryRefs,
} from "@leitwerk-dev/domain";

export interface StructuralProcessState {
	semanticEntryRefs: ProcessSemanticEntryRefs;
	productRefs: ProcessProductRefs;
}

export function createEmptyStructuralProcessState(): StructuralProcessState {
	return {
		semanticEntryRefs: createEmptyProcessSemanticEntryRefs(),
		productRefs: createEmptyProcessProductRefs(),
	};
}

export function parseStructuralProcessState(value: unknown): StructuralProcessState {
	const record = asUnknownRecord(value) ?? {};
	return {
		semanticEntryRefs: parseProcessSemanticEntryRefs(record.semanticEntryRefs),
		productRefs: parseProcessProductRefs(record.productRefs),
	};
}
