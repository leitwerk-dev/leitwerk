import { parseRepositoryProfileBindings } from "@leitwerk-dev/coding/repository-change-launch";

/** Server-owned, non-secret wiring for future launches. */
/** @public */
export interface ProfileBinding {
	/** @public */
	sshCredentialRef: string;
}
/** @public */
export type ProfileBindings = Readonly<Record<string, Readonly<ProfileBinding>>>;

/** @public */
export function parseProfileBindings(raw: unknown): ProfileBindings {
	return parseRepositoryProfileBindings(raw, "github-repo-change", {
		sshCredentialRef: "ssh_credential_ref",
	});
}
/** @public */
export function resolveProfileBinding(bindings: ProfileBindings, profile: string): ProfileBinding {
	return Object.hasOwn(bindings, profile)
		? { ...bindings[profile] }
		: { sshCredentialRef: profile };
}
