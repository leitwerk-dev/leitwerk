import { parseRepositoryProfileBindings } from "@leitwerk-dev/coding/repository-change-launch";

/** Server-owned, non-secret wiring for future launches. @internal */
export interface ProfileBinding {
	/** @internal */
	woodpeckerProfile: string;
	/** @internal */
	sshCredentialRef: string;
}
/** @internal */
export type ProfileBindings = Readonly<Record<string, Readonly<ProfileBinding>>>;

/** @internal */
export function parseProfileBindings(raw: unknown): ProfileBindings {
	return parseRepositoryProfileBindings(raw, "forgejo-repo-change", {
		woodpeckerProfile: "woodpecker_profile",
		sshCredentialRef: "ssh_credential_ref",
	});
}
/** @internal */
export function resolveProfileBinding(bindings: ProfileBindings, profile: string): ProfileBinding {
	return Object.hasOwn(bindings, profile)
		? { ...bindings[profile] }
		: { woodpeckerProfile: profile, sshCredentialRef: profile };
}
