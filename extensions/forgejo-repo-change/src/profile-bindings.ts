/** Server-owned, non-secret wiring for future launches. */
/** @internal */
export interface ProfileBinding {
	/** @internal */
	woodpeckerProfile: string;
	/** @internal */
	sshCredentialRef: string;
}
/** @internal */
export type ProfileBindings = Readonly<Record<string, Readonly<ProfileBinding>>>;

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}
function field(value: unknown, fallback: string, label: string): string {
	if (value === undefined) return fallback;
	if (typeof value !== "string" || !value.trim())
		throw new Error(`${label} must be a non-empty string`);
	return value.trim();
}
/** @internal */
export function parseProfileBindings(raw: unknown): ProfileBindings {
	const config = raw === undefined ? {} : record(raw, "forgejo-repo-change configuration");
	if (config.profile_bindings === undefined) return Object.freeze({});
	const mappings = record(config.profile_bindings, "profile_bindings");
	const entries = Object.entries(mappings).map(([profile, value]) => {
		if (!profile.trim() || profile.trim() !== profile)
			throw new Error(
				"profile_bindings keys must be non-empty profile names without surrounding whitespace",
			);
		const mapping = record(value, `profile_bindings.${profile}`);
		for (const key of Object.keys(mapping))
			if (key !== "woodpecker_profile" && key !== "ssh_credential_ref")
				throw new Error(`Unknown profile_bindings.${profile}.${key}`);
		return [
			profile,
			Object.freeze({
				woodpeckerProfile: field(
					mapping.woodpecker_profile,
					profile,
					`profile_bindings.${profile}.woodpecker_profile`,
				),
				sshCredentialRef: field(
					mapping.ssh_credential_ref,
					profile,
					`profile_bindings.${profile}.ssh_credential_ref`,
				),
			}),
		];
	});
	return Object.freeze(Object.fromEntries(entries));
}
/** @internal */
export function resolveProfileBinding(bindings: ProfileBindings, profile: string): ProfileBinding {
	return Object.hasOwn(bindings, profile)
		? { ...bindings[profile] }
		: { woodpeckerProfile: profile, sshCredentialRef: profile };
}
