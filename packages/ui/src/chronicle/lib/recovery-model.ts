import type { ModelProfileOptionSummary } from "@leitwerk-dev/protocol";

/** @internal */
export function recoveryModelSelection(
	profiles: readonly ModelProfileOptionSummary[],
	draft: string | null | undefined,
	current: string | null,
	inherited: string | null,
) {
	const profileId = draft === null ? inherited : (draft ?? current);
	const profile = profiles.find((candidate) => candidate.id === profileId) ?? null;
	return {
		profileId,
		profile,
		usable: profile?.availability === undefined || profile.availability === "available",
	};
}
