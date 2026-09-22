/** Recursively readonly observations detached from the running harness. @public */
export type TestObservation<T> = T extends readonly (infer V)[]
	? readonly TestObservation<V>[]
	: T extends object
		? { readonly [K in keyof T]: TestObservation<T[K]> }
		: T;

/** @internal */
export function observe<T>(value: T): TestObservation<T> {
	function freeze(value: unknown): void {
		if (value && typeof value === "object") {
			for (const child of Object.values(value)) freeze(child);
			Object.freeze(value);
		}
	}
	const detached = structuredClone(value);
	freeze(detached);
	return detached as TestObservation<T>;
}
