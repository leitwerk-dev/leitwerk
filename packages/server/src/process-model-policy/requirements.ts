import { compareModelProfileIds, modelCostRank } from "@leitwerk-dev/protocol";
import type { PolicyProcess, PolicyProfile } from "./types.js";

/** @internal */
export function requirementLayers(policy: PolicyProcess, turnId?: string) {
	return policy.requirements.concat(turnId ? (policy.turnRequirements[turnId] ?? []) : []);
}

/** Stable policy evidence; availability never participates. @internal */
export function profileRejections(policy: PolicyProcess, profile: PolicyProfile, turnId?: string) {
	const rejections: { origin: string; code: string; values: readonly string[] }[] = [];
	if (policy.allowedProfileIds && !policy.allowedProfileIds.has(profile.id))
		rejections.push({
			origin: `process_configs.${policy.id}.allowed_model_profiles`,
			code: "profile_not_allowed",
			values: [profile.id],
		});
	const labels = new Set(profile.labels);
	for (const { origin, requirements: r } of requirementLayers(policy, turnId)) {
		if (r.profiles && !r.profiles.includes(profile.id))
			rejections.push({ origin, code: "profile_not_allowed", values: r.profiles });
		const missing = r.labels?.all_of?.filter((label) => !labels.has(label)) ?? [];
		if (missing.length) rejections.push({ origin, code: "missing_labels", values: missing });
		if (r.labels?.any_of && !r.labels.any_of.some((label) => labels.has(label)))
			rejections.push({ origin, code: "no_matching_labels", values: r.labels.any_of });
		const forbidden = r.labels?.none_of?.filter((label) => labels.has(label)) ?? [];
		if (forbidden.length) rejections.push({ origin, code: "forbidden_labels", values: forbidden });
		for (const capability of r.capabilities ?? []) {
			if (profile.capabilities[capability] !== true)
				rejections.push({
					origin,
					code:
						profile.capabilities[capability] === false
							? "unsupported_capability"
							: "unknown_capability",
					values: [capability],
				});
		}
	}
	return rejections;
}

/** @internal */
export function rankedProfiles(
	policy: PolicyProcess,
	profiles: readonly PolicyProfile[],
	turnId?: string,
) {
	const eligible = profiles.filter((profile) => !profileRejections(policy, profile, turnId).length);
	const marked = eligible.filter((profile) => profile.default);
	const relevant = new Set(
		requirementLayers(policy, turnId).flatMap(({ requirements: r }) => [
			...(r.labels?.all_of ?? []),
			...(r.labels?.any_of ?? []),
		]),
	);
	const unrelated = (profile: PolicyProfile) =>
		new Set(profile.labels.filter((label) => !relevant.has(label))).size;
	const ranked = (marked.length ? marked : eligible).sort(
		(a, b) =>
			(marked.length ? unrelated(a) - unrelated(b) : 0) ||
			modelCostRank(a.labels) - modelCostRank(b.labels) ||
			compareModelProfileIds(a.id, b.id),
	);
	const minUnrelated = Math.min(...marked.map(unrelated));
	return {
		tiedProfileIds: marked
			.filter((profile) => unrelated(profile) === minUnrelated)
			.map((profile) => profile.id),
		marked: marked.length > 0,
		profiles: ranked,
	};
}
