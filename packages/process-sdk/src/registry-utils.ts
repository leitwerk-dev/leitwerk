/** @internal */
export interface UniqueRegistrationOptions<TValue> {
	/** @internal */
	duplicateMessage: string;
	/** @internal */
	validate?: (value: TValue) => void;
}

/** @internal */
export function registerUnique<TKey, TValue>(
	registry: Map<TKey, TValue>,
	key: TKey,
	value: TValue,
	options: UniqueRegistrationOptions<TValue>,
): void {
	if (registry.has(key)) {
		throw new Error(options.duplicateMessage);
	}
	options.validate?.(value);
	registry.set(key, value);
}

/** @internal */
export function cloneMap<TKey, TValue>(registry: ReadonlyMap<TKey, TValue>): Map<TKey, TValue> {
	return new Map(registry);
}

/** @internal */
export function cloneArrayValueMap<TKey, TValue>(
	registry: ReadonlyMap<TKey, readonly TValue[]>,
): Map<TKey, readonly TValue[]> {
	return new Map(Array.from(registry, ([key, values]) => [key, [...values]]));
}
