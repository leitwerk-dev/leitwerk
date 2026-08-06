import type { CapabilityToken } from "./capabilities.js";

export interface ProvidedCapability<T = unknown> {
	token: CapabilityToken<T>;
	value: T;
}

export interface CapabilityAccessor {
	provide<T>(token: CapabilityToken<T>, value: T): void;
	get<T>(token: CapabilityToken<T>): T | T[] | undefined;
	require<T>(token: CapabilityToken<T>): T | T[];
}

export function createCapabilityAccessor(
	provided: readonly ProvidedCapability[] = [],
): CapabilityAccessor {
	const singleCapabilities = new Map<string, unknown>();
	const multiCapabilities = new Map<string, unknown[]>();

	for (const entry of provided) {
		if (entry.token.cardinality === "multi") {
			const list = multiCapabilities.get(entry.token.id) ?? [];
			list.push(entry.value);
			multiCapabilities.set(entry.token.id, list);
			continue;
		}
		singleCapabilities.set(entry.token.id, entry.value);
	}

	return {
		provide(token, value) {
			if (token.cardinality === "multi") {
				const list = multiCapabilities.get(token.id) ?? [];
				list.push(value);
				multiCapabilities.set(token.id, list);
				return;
			}
			if (singleCapabilities.has(token.id)) {
				throw new Error(`Capability '${token.id}' is already provided`);
			}
			singleCapabilities.set(token.id, value);
		},
		get<T>(token: CapabilityToken<T>): T | T[] | undefined {
			if (token.cardinality === "multi") {
				return [...(multiCapabilities.get(token.id) ?? [])] as T[];
			}
			return singleCapabilities.get(token.id) as T | undefined;
		},
		require<T>(token: CapabilityToken<T>): T | T[] {
			const value = this.get(token);
			if (
				value === undefined ||
				(Array.isArray(value) && token.cardinality === "multi" && value.length === 0)
			) {
				throw new Error(`Required capability '${token.id}' is not available`);
			}
			return value;
		},
	};
}
