import type { ProcessLaunchPlan } from "@leitwerk-dev/process-sdk";
import { describe, expect, it } from "vitest";
import {
	createTestLaunchPlan,
	createTestModelPolicy,
} from "../test-helpers/process-model-fixtures.js";

function launch(overrides: Partial<ProcessLaunchPlan["processInput"]> = {}): ProcessLaunchPlan {
	return createTestLaunchPlan({ launcherId: "test", processInput: overrides });
}

describe("server process model policy launch preparation", () => {
	it("rejects process-id mismatches", () => {
		const mismatchedLaunch = { ...launch(), processId: "other" };
		const result = createTestModelPolicy().policy.prepareLaunchPlan(mismatchedLaunch);
		expect(result).toEqual({
			ok: false,
			launchPlan: mismatchedLaunch,
			modelConfig: { defaultModelProfileId: null, turnConfigs: {} },
			errors: [
				{
					code: "process_id_mismatch",
					message: "Launch plan process 'other' does not match input process 'policy'",
				},
			],
		});
	});

	it("prepares a valid launch and resolves its initial model", () => {
		const result = createTestModelPolicy().policy.prepareLaunchPlan(
			launch({ defaultModelProfileId: "first" }),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.warnings).toEqual([]);
		expect(result.launchPlan.processInput).toMatchObject({
			defaultModelProfileId: "first",
			initialDefaultModelProfileId: "first",
		});
	});

	it("persists explicit selected-turn model provenance", () => {
		const result = createTestModelPolicy().policy.prepareLaunchPlan(
			launch({ selectedTurnModelProfileId: "second" }),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.launchPlan.processInput).toMatchObject({
			selectedTurnModelProfileId: "second",
			selectedTurnModelKind: "explicit",
			selectedTurnModelSource: "launch_override",
		});
	});

	it("rejects unknown and disallowed profiles and omits them in omit mode", () => {
		const plan = launch();
		const policy = createTestModelPolicy({ allowedProfileIds: ["first"] }).policy;
		for (const [profileId, code] of [
			["missing", "unknown_model_profile"],
			["second", "model_profile_not_allowed"],
		] as const) {
			const rejected = policy.prepareLaunchPlan(plan, {
				modelConfig: { turnConfigs: { run: { modelProfileId: profileId } } },
			});
			expect(rejected).toMatchObject({
				ok: false,
				errors: [{ code, message: expect.any(String) }],
			});

			const omitted = policy.prepareLaunchPlan(plan, {
				modelConfig: { turnConfigs: { run: { modelProfileId: profileId } } },
				invalidModelConfig: "omit",
			});
			expect(omitted.ok).toBe(true);
			if (!omitted.ok) continue;
			expect(omitted.warnings).toMatchObject([{ code }]);
			expect(omitted.launchPlan.processInput.turnConfigsJson).toBeNull();
		}
	});

	it("rejects model configuration for non-LLM turns", () => {
		const result = createTestModelPolicy().policy.prepareLaunchPlan(launch(), {
			modelConfig: { turnConfigs: { unknown: { modelProfileId: "first" } } },
		});
		expect(result).toMatchObject({
			ok: false,
			errors: [
				{
					code: "unknown_llm_turn",
					message: "Turn 'unknown' is not a known LLM turn for process 'policy'",
				},
			],
		});
	});

	it("validates selected-turn relationships", () => {
		const policy = createTestModelPolicy().policy;
		const withoutSelectedTurn = policy.prepareLaunchPlan({
			...launch({ selectedTurnId: null, selectedTurnModelProfileId: "first" }),
			startTurnId: null,
		});
		expect(withoutSelectedTurn).toMatchObject({
			ok: false,
			errors: [
				{
					code: "selected_turn_model_requires_selected_turn",
					message: "Selected turn model profile 'first' requires a selected turn",
				},
			],
		});

		const nonLlmSelectedTurn = policy.prepareLaunchPlan({
			...launch({ selectedTurnId: "unknown", selectedTurnModelProfileId: "first" }),
			startTurnId: "unknown",
		});
		expect(nonLlmSelectedTurn).toMatchObject({
			ok: false,
			errors: [
				{
					code: "selected_turn_model_requires_llm_turn",
					message:
						"Selected turn model profile 'first' requires selected turn 'unknown' to be an LLM turn",
				},
			],
		});
	});

	it("reports when the selected LLM turn has no resolvable model", () => {
		const result = createTestModelPolicy({ profiles: [] }).policy.prepareLaunchPlan(launch());
		expect(result).toMatchObject({
			ok: false,
			errors: [
				{
					code: "model_required",
					message: "A model is required for turn 'run'",
				},
			],
		});
	});

	it("strictly rejects embedded JSON and drops it in omit mode", () => {
		const policy = createTestModelPolicy().policy;
		const plan = launch({ turnConfigsJson: "not-json" });
		expect(policy.prepareLaunchPlan(plan).ok).toBe(false);
		const omitted = policy.prepareLaunchPlan(plan, { invalidModelConfig: "omit" });
		expect(omitted.ok).toBe(true);
		if (!omitted.ok) return;
		expect(omitted.warnings).toMatchObject([
			{
				code: "invalid_turn_configs_json",
				message: "turnConfigsJson must be valid JSON",
			},
		]);
	});

	it("replaces embedded model configuration when requested", () => {
		const result = createTestModelPolicy().policy.prepareLaunchPlan(
			launch({
				defaultModelProfileId: "first",
				turnConfigsJson: JSON.stringify({ run: { modelProfileId: "first" } }),
			}),
			{
				replaceModelConfig: true,
				modelConfig: { defaultModelProfileId: "second" },
			},
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.launchPlan.processInput).toMatchObject({
			defaultModelProfileId: "second",
			initialDefaultModelProfileId: "second",
			turnConfigsJson: null,
		});
	});
});
