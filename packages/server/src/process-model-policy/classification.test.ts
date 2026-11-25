import { describe, expect, it } from "vitest";
import {
	createModelAvailabilitySnapshot,
	createTestModelPolicy,
	createTestProcessInstance,
} from "../test-helpers/process-model-fixtures.js";

function evaluate(
	input: Parameters<typeof createTestModelPolicy>[0],
	unavailable: string[] = [],
	override?: string,
) {
	const { policy } = createTestModelPolicy(input);
	return policy.evaluate({
		kind: "process_turn",
		process: createTestProcessInstance(),
		turnId: "run",
		...(override ? { modelOverride: override } : {}),
		availability: createModelAvailabilitySnapshot(
			(input?.profiles ?? []).map((p) => ({
				profileId: p.id,
				availability: unavailable.includes(p.id) ? "unavailable" : "available",
			})),
		),
	});
}

const profiles = [
	{ id: "general", labels: ["writing"] },
	{ id: "sol", labels: ["coding", "economy"], default: true },
	{ id: "broad", labels: ["coding", "planning", "free"], default: true },
];

describe("deterministic model classification", () => {
	it("projects turn eligibility and exclusion origins independently of availability", () => {
		const { policy } = createTestModelPolicy({
			profiles,
			defaultProfileId: "general",
			turnRequirements: { labels: { all_of: ["coding"] } },
		});
		const schema = policy.project({
			kind: "launcher_schema",
			processId: "policy",
			availability: createModelAvailabilitySnapshot(
				profiles.map((p) => ({ profileId: p.id, availability: "unavailable" })),
			),
		});
		expect(schema.profilesByTurn?.run.map((p) => p.id)).toEqual(["broad", "sol"]);
		expect(schema.excludedProfiles?.run).toMatchObject([
			{
				id: "general",
				availability: "unavailable",
				policyReason: expect.stringContaining("turn:policy/run"),
			},
		]);
	});
	it("skips an incompatible preference, not an unavailable winner", () => {
		const input = {
			profiles,
			defaultProfileId: "general",
			turnRequirements: { labels: { all_of: ["coding"] } },
		};
		expect(evaluate(input)).toMatchObject({
			ok: true,
			selection: { modelProfileId: "sol", provenance: { source: "marked_default" } },
		});
		expect(evaluate(input, ["sol"])).toMatchObject({
			ok: false,
			code: "model_unavailable",
			selection: { modelProfileId: "sol" },
		});
		expect(evaluate(input, [], "general")).toMatchObject({
			ok: false,
			code: "model_profile_not_allowed",
			selection: { modelProfileId: "general" },
		});
	});
	it("preserves eligible inherited defaults ahead of marked defaults", () => {
		expect(
			evaluate({
				profiles,
				defaultProfileId: "broad",
				turnRequirements: { labels: { all_of: ["coding"] } },
			}),
		).toMatchObject({
			ok: true,
			selection: { modelProfileId: "broad", provenance: { source: "catalog_default" } },
		});
	});
	it("keeps each any-of clause conjunctive and none-of labels non-relevant", () => {
		const input = {
			profiles,
			defaultProfileId: "general",
			processRequirements: { labels: { any_of: ["coding", "writing"] } },
			turnRequirements: { labels: { any_of: ["planning", "research"] } },
		};
		expect(evaluate(input)).toMatchObject({ ok: true, selection: { modelProfileId: "broad" } });
		expect(
			evaluate({ ...input, operatorTurnRequirements: { labels: { none_of: ["planning"] } } }),
		).toMatchObject({ ok: false, code: "model_required", selection: null });
	});
	it("counts cost and organization labels in specificity; duplicates and ordering have no effect", () => {
		for (const ordered of [profiles, [...profiles].reverse()]) {
			expect(
				evaluate({
					profiles: [...ordered, { id: "minimal", labels: ["coding", "coding"], default: true }],
					defaultProfileId: "general",
					turnRequirements: { labels: { all_of: ["coding", "coding"] } },
				}),
			).toMatchObject({ ok: true, selection: { modelProfileId: "minimal" } });
		}
	});
	it("uses first cost label then fixed ID ordering when no marked default is eligible", () => {
		expect(
			evaluate({
				profiles: [
					{ id: "general" },
					{ id: "z", labels: ["coding", "premium", "free"] },
					{ id: "a", labels: ["coding", "free"] },
					{ id: "other", labels: ["coding"] },
				],
				defaultProfileId: "general",
				turnRequirements: { labels: { all_of: ["coding"] } },
			}),
		).toMatchObject({
			ok: true,
			selection: { modelProfileId: "a", provenance: { source: "automatic" } },
		});
	});
	it("fails closed for unknown and unsupported capabilities without probing status", () => {
		const input = {
			profiles: [{ id: "general" }, { id: "vision" }],
			defaultProfileId: "general",
			turnRequirements: { capabilities: ["image-input"] },
		};
		expect(evaluate(input)).toMatchObject({ ok: false, code: "model_required" });
		expect(
			evaluate({
				...input,
				capabilities: (_provider: string, model: string) => ({ "image-input": model === "vision" }),
			}),
		).toMatchObject({ ok: true, selection: { modelProfileId: "vision" } });
		expect(evaluate(input, [], "general")).toMatchObject({
			ok: false,
			code: "model_profile_not_allowed",
			rejections: [expect.objectContaining({ code: "unknown_capability" })],
		});
	});
	it("never substitutes an unknown configured default", () => {
		expect(
			evaluate({
				profiles,
				defaultProfileId: "deleted",
				turnRequirements: { labels: { all_of: ["coding"] } },
			}),
		).toMatchObject({
			ok: false,
			code: "unknown_model_profile",
			selection: { modelProfileId: "deleted" },
		});
	});
});
