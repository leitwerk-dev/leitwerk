/** Object parameters for a tool bound to a current process project. */
export function projectParameters(
	properties: Record<string, unknown> = {},
	required: readonly string[] = Object.keys(properties),
): Record<string, unknown> {
	return {
		type: "object",
		properties: {
			projectKey: { type: "string", description: "Current process project key" },
			...properties,
		},
		required: ["projectKey", ...required],
	};
}

export function objectArg(
	value: unknown,
	message = "Tool arguments must be an object",
): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
	return value as Record<string, unknown>;
}

/** Read required integration-tool arguments at the runtime boundary. */
export function stringArg(args: Record<string, unknown>, name: string): string {
	const value = args[name];
	if (typeof value !== "string" || !value.trim())
		throw new Error(`'${name}' must be a non-empty string`);
	return value.trim();
}

export function numberArg(args: Record<string, unknown>, name: string): number {
	const value = args[name];
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0)
		throw new Error(`'${name}' must be a positive integer`);
	return value;
}
