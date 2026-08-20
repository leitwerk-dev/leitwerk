import {
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
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return createEmptyStructuralProcessState();
	}
	const record = value as Record<string, unknown>;
	return {
		semanticEntryRefs: parseProcessSemanticEntryRefs(record.semanticEntryRefs),
		productRefs: parseProcessProductRefs(record.productRefs),
	};
}
