import * as v from "valibot";

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

/** @internal */
export const modelPolicyIdentifiersSchema = v.array(
	v.pipe(v.string(), v.regex(MODEL_POLICY_IDENTIFIER)),
);

/** @internal */
export const modelRequirementsSchema = v.strictObject({
	/** @internal */
	profiles: v.optional(
		v.pipe(
			v.array(
				v.pipe(
					v.string(),
					v.check((value) => !!value.trim() && value === value.trim()),
				),
			),
			v.nonEmpty(),
		),
	),
	/** @internal */
	capabilities: v.optional(modelPolicyIdentifiersSchema),
	/** @internal */
	labels: v.optional(
		v.strictObject({
			/** @internal */
			all_of: v.optional(modelPolicyIdentifiersSchema),
			/** @internal */
			any_of: v.optional(v.pipe(modelPolicyIdentifiersSchema, v.nonEmpty())),
			/** @internal */
			none_of: v.optional(modelPolicyIdentifiersSchema),
		}),
	),
});

/** Reject invalid declarations at definition/configuration time. @internal */
export function assertValidModelRequirements(requirements: ModelRequirements): void {
	v.parse(modelRequirementsSchema, requirements, { message: "Invalid model requirements" });
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
