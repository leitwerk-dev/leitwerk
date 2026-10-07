/** @internal */
export type CapabilityCardinality = "single" | "multi";

/** @public */
export interface CapabilityToken<_TValue> {
	/** @internal */
	readonly id: string;
	/** @internal */
	readonly cardinality: CapabilityCardinality;
}

/** @public */
export function createCapabilityToken<TValue>(
	id: string,
	options: {
		/** @internal */
		cardinality?: CapabilityCardinality;
	} = {},
): CapabilityToken<TValue> {
	return {
		id,
		cardinality: options.cardinality ?? "single",
	};
}
