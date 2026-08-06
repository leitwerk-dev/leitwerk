export type CapabilityCardinality = "single" | "multi";

export interface CapabilityToken<_TValue> {
	readonly id: string;
	readonly cardinality: CapabilityCardinality;
}

export function createCapabilityToken<TValue>(
	id: string,
	options: { cardinality?: CapabilityCardinality } = {},
): CapabilityToken<TValue> {
	return {
		id,
		cardinality: options.cardinality ?? "single",
	};
}
