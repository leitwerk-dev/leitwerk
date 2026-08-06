import {
	type Codec,
	createEmptyStructuralProcessState,
	parseStructuralProcessState,
	type StructuralProcessState,
} from "@leitwerk-dev/process-sdk";

export const structuralProcessStateCodec: Codec<StructuralProcessState> = {
	parse(value) {
		return parseStructuralProcessState(value);
	},
	serialize(value) {
		return value;
	},
};

export function createStructuralProcessState(
	overrides: Partial<Omit<StructuralProcessState, "semanticEntryRefs">> & {
		semanticEntryRefs?: Partial<StructuralProcessState["semanticEntryRefs"]>;
	} = {},
): StructuralProcessState {
	const baseState = createEmptyStructuralProcessState();
	return {
		...baseState,
		...overrides,
		semanticEntryRefs: {
			...baseState.semanticEntryRefs,
			...(overrides.semanticEntryRefs ?? {}),
		},
	};
}

export function createStructuralStateJson(
	overrides: Parameters<typeof createStructuralProcessState>[0] = {},
): string {
	return JSON.stringify(createStructuralProcessState(overrides));
}
