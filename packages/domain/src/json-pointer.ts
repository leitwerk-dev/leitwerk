/** Resolve a validated JSON Pointer through own properties only. @internal */
export function resolveJsonPointer(value: unknown, pointer: string): unknown {
	if (pointer === "") return value;
	for (const token of pointer.slice(1).split("/")) {
		const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
		if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) return undefined;
		value = (value as Record<string, unknown>)[key];
	}
	return value;
}
