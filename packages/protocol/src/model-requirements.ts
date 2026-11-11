/** Static model restrictions. Every layer is conjunctive; unknown capability support fails closed. @public */
export interface ModelRequirements {
	/** Installation-specific profile allowlist. Empty lists are invalid. @public */
	readonly profiles?: readonly string[];
	/** Provider-established capabilities required by the caller. @public */
	readonly capabilities?: readonly string[];
	/** Operator-owned, case-sensitive labels. @public */
	readonly labels?: {
		/** @public */
		readonly all_of?: readonly string[];
		/** At least one label in this clause must match. Empty lists are invalid. @public */
		readonly any_of?: readonly string[];
		/** @public */
		readonly none_of?: readonly string[];
	};
}

/** Policy label and capability identifiers are lowercase ASCII, with optional hyphens, underscores, and dots. @public */
export const MODEL_POLICY_IDENTIFIER = /^[a-z][a-z0-9_.-]*$/;

/** Reject invalid declarations at definition/configuration time. @internal */
export function assertValidModelRequirements(requirements: ModelRequirements): void {
	const object = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.keys(value).every((key) => keys.includes(key));
	if (
		!object(requirements, ["profiles", "capabilities", "labels"]) ||
		(requirements.labels !== undefined &&
			!object(requirements.labels, ["all_of", "any_of", "none_of"]))
	)
		throw new Error("Invalid model requirements object");
	for (const [key, values] of Object.entries({
		profiles: requirements.profiles,
		capabilities: requirements.capabilities,
		all_of: requirements.labels?.all_of,
		any_of: requirements.labels?.any_of,
		none_of: requirements.labels?.none_of,
	})) {
		if (values === undefined) continue;
		if (!Array.isArray(values) || ((key === "profiles" || key === "any_of") && !values.length))
			throw new Error(`Invalid model requirements: ${key} must be a non-empty array`);
		for (const value of values) {
			if (
				typeof value !== "string" ||
				(key === "profiles"
					? !value.trim() || value !== value.trim()
					: !MODEL_POLICY_IDENTIFIER.test(value))
			)
				throw new Error(`Invalid model requirements: ${key} identifier '${value}'`);
		}
	}
}

/** Fixed presentation and deterministic tie-break order; never inferred from prices. @internal */
export const MODEL_COST_LABELS = ["free", "economy", "standard", "premium"] as const;

/** @internal */
export function modelCostRank(labels: readonly string[] = []): number {
	const rank = MODEL_COST_LABELS.findIndex((label) => labels.includes(label));
	return rank < 0 ? MODEL_COST_LABELS.length : rank;
}

/** Locale-independent identity ordering. @internal */
export function compareModelProfileIds(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
