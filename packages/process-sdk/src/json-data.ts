/** Validate and detach JSON data without silently dropping unsupported values. */
/** @internal */
export function parseJsonData(
	value: unknown,
	message = "Value must be JSON-serializable",
): unknown {
	const ancestors = new Set<object>();
	function parse(value: unknown): unknown {
		if (value === null || typeof value === "string" || typeof value === "boolean") return value;
		if (typeof value === "number" && Number.isFinite(value)) return value;
		if (!value || typeof value !== "object" || ancestors.has(value)) throw new Error(message);
		ancestors.add(value);
		try {
			if (Array.isArray(value)) return Array.from(value, parse);
			if (
				![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
				Object.getOwnPropertySymbols(value).length
			)
				throw new Error(message);
			return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, parse(item)]));
		} finally {
			ancestors.delete(value);
		}
	}
	return parse(value);
}
