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

/** @public */
export interface StructuralProcessState {
	/** @internal */
	semanticEntryRefs: ProcessSemanticEntryRefs;
	/** @internal */
	productRefs: ProcessProductRefs;
}

/** @internal */
export const structuralStateCodec: Codec<StructuralProcessState> = {
	parse: parseStructuralProcessState,
	serialize: (value) => value,
};

/** @public */
export function createEmptyStructuralProcessState(): StructuralProcessState {
	return {
		semanticEntryRefs: createEmptyProcessSemanticEntryRefs(),
		productRefs: createEmptyProcessProductRefs(),
	};
}

/** @public */
export function parseStructuralProcessState(value: unknown): StructuralProcessState {
	const record = asUnknownRecord(value) ?? {};
	return {
		semanticEntryRefs: parseProcessSemanticEntryRefs(record.semanticEntryRefs),
		productRefs: parseProcessProductRefs(record.productRefs),
	};
}
