import { describe, expect, it } from "vitest";
import {
	buildLauncherModelSummaryView,
	countTurnModelOverrides,
	describeDefaultModelDisplayLine,
	describeTurnModelDisplayLine,
	formatLauncherModelSummaryStatus,
	getDefaultModelBlankOptionLabel,
	getDefaultModelSelectableProfiles,
	getLauncherModelCustomizationState,
	getTurnModelBlankOptionLabel,
} from "./launcher-model-config.js";

const recommendedProfile = {
	id: "claude_fast",
	label: "claude_fast — anthropic/claude-sonnet-4-20250514",
	description: "Thinking level: medium",
	availability: "available",
} as const;

const customProfile = {
	id: "local_qwen",
	label: "local_qwen — ollama/qwen2.5-coder:14b",
	description: "Thinking level: low",
	availability: "available",
} as const;

describe("launcher model config helpers", () => {
	describe("customization state", () => {
		it("counts only non-blank turn overrides", () => {
			expect(
				countTurnModelOverrides({
					draft_plan: "local_qwen",
					implement_change: "  ",
					review_plan: "claude_fast",
				}),
			).toBe(2);
		});

		it("tracks the major customization modes", () => {
			expect(
				getLauncherModelCustomizationState({
					defaultModelProfileId: "",
					turnModelProfileIds: { draft_plan: "", implement_change: "" },
				}),
			).toMatchObject({ mode: "recommended", hasCustomizations: false });

			expect(
				getLauncherModelCustomizationState({
					defaultModelProfileId: "claude_fast",
					turnModelProfileIds: { draft_plan: "", implement_change: "" },
				}),
			).toMatchObject({ mode: "default_only", hasCustomizations: true });

			expect(
				getLauncherModelCustomizationState({
					defaultModelProfileId: "",
					turnModelProfileIds: { draft_plan: "local_qwen", implement_change: "" },
				}),
			).toMatchObject({ mode: "turn_overrides_only", hasCustomizations: true });

			expect(
				getLauncherModelCustomizationState({
					defaultModelProfileId: "claude_fast",
					turnModelProfileIds: { draft_plan: "local_qwen", implement_change: "" },
				}),
			).toMatchObject({ mode: "mixed", hasCustomizations: true });
		});
	});

	describe("blank option labels", () => {
		it("shows the recommended model name in the default-model blank option", () => {
			expect(getDefaultModelBlankOptionLabel(recommendedProfile)).toBe("Recommended (claude_fast)");
			expect(getDefaultModelBlankOptionLabel(null)).toBe("Recommended");
			expect(getTurnModelBlankOptionLabel()).toBe("Use process default");
		});

		it("keeps the recommended default out of the explicit selectable profiles", () => {
			expect(
				getDefaultModelSelectableProfiles({
					availableProfiles: [recommendedProfile, customProfile],
					recommendedProfile,
				}),
			).toEqual([customProfile]);
		});
	});

	describe("display lines", () => {
		it("preserves whether the default comes from the catalog, process config, or launch override", () => {
			const catalogDefault = describeDefaultModelDisplayLine({
				source: "catalog_default",
				profile: recommendedProfile,
			});
			const processDefault = describeDefaultModelDisplayLine({
				source: "process_config_default",
				profile: customProfile,
			});
			const launchOverride = describeDefaultModelDisplayLine({
				source: "instance_default",
				profile: customProfile,
			});

			expect(catalogDefault).toMatchObject({
				state: "recommended",
				source: "catalog_default",
				modelName: "claude_fast",
			});
			expect(processDefault).toMatchObject({
				state: "recommended",
				source: "process_config_default",
				modelName: "local_qwen",
			});
			expect(launchOverride).toMatchObject({
				state: "custom",
				source: "instance_default",
				modelName: "local_qwen",
			});
		});

		it("classifies turns from their effective source instead of matching profile ids", () => {
			const defaultLine = describeDefaultModelDisplayLine({
				source: "instance_default",
				profile: customProfile,
			});

			expect(
				describeTurnModelDisplayLine({
					turnId: "draft_plan",
					description: "Draft plan",
					effective: { source: "process_config_default", profile: customProfile },
					defaultLine,
				}),
			).toMatchObject({ state: "use_process_default", source: "process_config_default" });

			expect(
				describeTurnModelDisplayLine({
					turnId: "review_plan",
					description: "Review plan",
					effective: { source: "process_config_turn", profile: customProfile },
					defaultLine,
				}),
			).toMatchObject({
				state: "recommended",
				source: "process_config_turn",
				modelName: "local_qwen",
			});

			expect(
				describeTurnModelDisplayLine({
					turnId: "implement",
					description: "Implement change",
					effective: { source: "instance_turn_config", profile: customProfile },
					defaultLine,
				}),
			).toMatchObject({ state: "custom", source: "instance_turn_config" });
		});
	});

	describe("summary view", () => {
		it("summarizes all effective turn models and marks the launch as recommended when unchanged", () => {
			const summary = buildLauncherModelSummaryView({
				preview: {
					defaultModel: { source: "catalog_default", profile: recommendedProfile },
					turns: [
						{
							turnId: "draft_plan",
							description: "Draft plan",
							effective: { source: "process_config_turn", profile: customProfile },
						},
						{
							turnId: "implement_change",
							description: "Implement change",
							effective: { source: "catalog_default", profile: recommendedProfile },
						},
					],
				},
				hasCustomizations: false,
			});

			expect(summary.mode).toBe("recommended");
			expect(
				summary.turns.map((turn) => [turn.turnId, turn.modelName, turn.source, turn.isAdjusted]),
			).toEqual([
				["draft_plan", "local_qwen", "process_config_turn", false],
				["implement_change", "claude_fast", "catalog_default", false],
			]);
		});

		it("marks only explicit turn overrides as adjusted rows", () => {
			const summary = buildLauncherModelSummaryView({
				preview: {
					defaultModel: { source: "instance_default", profile: customProfile },
					turns: [
						{
							turnId: "draft_plan",
							description: "Draft plan",
							effective: { source: "instance_default", profile: customProfile },
						},
						{
							turnId: "implement_change",
							description: "Implement change",
							effective: { source: "instance_turn_config", profile: recommendedProfile },
						},
					],
				},
				hasCustomizations: true,
			});

			expect(summary.mode).toBe("adjusted");
			expect(summary.turns).toHaveLength(2);
			expect(summary.turns[0]).toMatchObject({
				modelName: "local_qwen",
				source: "instance_default",
				isAdjusted: false,
			});
			expect(summary.turns[1]).toMatchObject({
				modelName: "claude_fast",
				source: "instance_turn_config",
				isAdjusted: true,
			});
		});

		it("returns an empty turn list when no preview is available yet", () => {
			expect(
				buildLauncherModelSummaryView({ preview: null, hasCustomizations: false }),
			).toMatchObject({
				mode: "recommended",
				turns: [],
			});
		});
	});

	describe("summary status copy", () => {
		it("maps summary modes to stable sentences", () => {
			expect(formatLauncherModelSummaryStatus("recommended")).toBe("Use recommended models");
			expect(formatLauncherModelSummaryStatus("adjusted")).toBe("Uses adjusted models");
		});
	});
});
