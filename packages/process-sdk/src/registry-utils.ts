export interface UniqueRegistrationOptions<TValue> {
	duplicateMessage: string;
	validate?: (value: TValue) => void;
}

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

export function cloneMap<TKey, TValue>(registry: ReadonlyMap<TKey, TValue>): Map<TKey, TValue> {
	return new Map(registry);
}

export function cloneArrayValueMap<TKey, TValue>(
	registry: ReadonlyMap<TKey, readonly TValue[]>,
): Map<TKey, readonly TValue[]> {
	const cloned = new Map<TKey, readonly TValue[]>();
	for (const [key, values] of registry) {
		cloned.set(key, [...values]);
	}
	return cloned;
}
