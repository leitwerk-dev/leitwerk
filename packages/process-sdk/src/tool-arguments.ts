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
