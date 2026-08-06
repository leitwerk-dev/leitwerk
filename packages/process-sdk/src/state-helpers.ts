import {
	createEmptyProcessProductRefs,
	createEmptyProcessSemanticEntryRefs,
	type ProcessProductRefs,
	type ProcessSemanticEntryRefs,
	parseProcessProductRefs,
	parseProcessSemanticEntryRefs,
	parseReviewSubject,
	type ReviewSubject,
} from "@leitwerk-dev/domain";

export interface StructuralProcessState {
	semanticEntryRefs: ProcessSemanticEntryRefs;
	productRefs: ProcessProductRefs;
	reviewSubject: ReviewSubject | null;
}

export function createEmptyStructuralProcessState(): StructuralProcessState {
	return {
		semanticEntryRefs: createEmptyProcessSemanticEntryRefs(),
		productRefs: createEmptyProcessProductRefs(),
		reviewSubject: null,
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
		reviewSubject: parseReviewSubject(record.reviewSubject),
	};
}
