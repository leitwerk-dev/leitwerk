import {
	asUnknownRecord,
	createEmptyProcessProductRefs,
	createEmptyProcessSemanticEntryRefs,
	type ProcessProductRefs,
	type ProcessSemanticEntryRefs,
	parseProcessProductRefs,
	parseProcessSemanticEntryRefs,
} from "@leitwerk-dev/domain";
import type { Codec } from "./extension-api.js";

export interface StructuralProcessState {
	semanticEntryRefs: ProcessSemanticEntryRefs;
	productRefs: ProcessProductRefs;
}

export const structuralStateCodec: Codec<StructuralProcessState> = {
	parse: parseStructuralProcessState,
	serialize: (value) => value,
};

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
