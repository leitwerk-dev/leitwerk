function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}

/** Strict profile wiring shared by repository-change extensions. @internal */
export function parseRepositoryProfileBindings<K extends string>(
	raw: unknown,
	extensionId: string,
	fields: Record<K, string>,
): Readonly<Record<string, Readonly<Record<K, string>>>> {
	const config = raw === undefined ? {} : record(raw, `${extensionId} configuration`);
	if (config.profile_bindings === undefined) return Object.freeze({});
	const mappings = record(config.profile_bindings, "profile_bindings");
	return Object.freeze(
		Object.fromEntries(
			Object.entries(mappings).map(([profile, value]) => {
				if (!profile.trim() || profile.trim() !== profile)
					throw new Error(
						"profile_bindings keys must be non-empty profile names without surrounding whitespace",
					);
				const mapping = record(value, `profile_bindings.${profile}`);
				for (const key of Object.keys(mapping))
					if (!Object.values(fields).includes(key))
						throw new Error(`Unknown profile_bindings.${profile}.${key}`);
				const binding = Object.fromEntries(
					Object.entries<string>(fields).map(([field, key]) => {
						const value = mapping[key];
						if (value !== undefined && (typeof value !== "string" || !value.trim()))
							throw new Error(`profile_bindings.${profile}.${key} must be a non-empty string`);
						return [field, value === undefined ? profile : (value as string).trim()];
					}),
				) as Record<K, string>;
				return [profile, Object.freeze(binding)];
			}),
		),
	);
}
