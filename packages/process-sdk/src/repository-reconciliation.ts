import { IntegrationHttpError } from "./integration-http.js";

/** @internal */
export async function existingObject<T>(read: () => Promise<T>): Promise<T | null> {
	try {
		return await read();
	} catch (error) {
		if (error instanceof IntegrationHttpError && error.status === 404) return null;
		throw error;
	}
}

/** @internal */
export function matchesPatch(current: object, patch: Record<string, unknown>): boolean {
	const fields = current as Record<string, unknown>;
	return Object.entries(patch).every(([key, expected]) => {
		const labelKey = Array.isArray(expected) && typeof expected[0] === "number" ? "id" : "name";
		const normalize = (value: unknown) =>
			key === "labels" && Array.isArray(value)
				? [
						...new Set(
							value.map((label) =>
								typeof label === "object" && label !== null ? label[labelKey] : label,
							),
						),
					].sort()
				: value;
		return JSON.stringify(normalize(fields[key])) === JSON.stringify(normalize(expected));
	});
}
