import { describe, expect, it } from "vitest";
import { buildActionModelDisplay } from "./action-model-display.js";

const availableProfiles = [
	{
		id: "claude-sonnet-4",
		label: "claude-sonnet-4 — Claude Sonnet 4",
		description: "Balanced model",
		availability: "available" as const,
	},
	{
		id: "claude-sonnet-4-thinking",
		label: "claude-sonnet-4-thinking — Claude Sonnet 4 (thinking)",
		description: "Thinking model",
		availability: "available" as const,
	},
	{
		id: "gpt-5-mini",
		label: "gpt-5-mini — GPT-5 Mini",
		description: "Fast model",
		availability: "available" as const,
	},
];

const resolvedModel = {
	status: "resolved" as const,
	modelProfileId: "claude-sonnet-4",
	source: "process_config_default" as const,
	error: null,
};

const warmPromptCache = {
	previousModelProfileId: "claude-sonnet-4",
	compatibleModelProfileIds: ["claude-sonnet-4", "claude-sonnet-4-thinking"],
	expiresAt: "2099-01-01T00:00:00.000Z",
};

function preview(overrides: Record<string, unknown> = {}) {
	return {
		kind: "llm_turn" as const,
		turnId: "implement_fix",
		description: "Implement the next revision",
		resolvedModel,
		warmPromptCache,
		...overrides,
	};
}

describe("buildActionModelDisplay", () => {
	it("shows the resolved model and source for the blank option", () => {
		const display = buildActionModelDisplay({
			modelPreview: preview(),
			availableProfiles,
			selectedModelOverrideValue: "",
		});
		expect(display?.blankOptionLabel).toContain("claude-sonnet-4");
		expect(display?.helperText).toContain("config-file default");
		expect(display?.switchCostWarningText).toBeNull();
	});

	it("compares the resolved default with the previous model", () => {
		const display = buildActionModelDisplay({
			modelPreview: preview({
				resolvedModel: { ...resolvedModel, modelProfileId: "gpt-5-mini" },
			}),
			availableProfiles,
			selectedModelOverrideValue: "",
		});
		expect(display?.switchCostWarningText).toContain("claude-sonnet-4");
	});

	it("suppresses the warning for a thinking-mode variant of the previous model", () => {
		const display = buildActionModelDisplay({
			modelPreview: preview(),
			availableProfiles,
			selectedModelOverrideValue: "claude-sonnet-4-thinking",
		});
		expect(display?.switchCostWarningText).toBeNull();
	});

	it("warns for a genuine override and recommends the previous profile", () => {
		const display = buildActionModelDisplay({
			modelPreview: preview(),
			availableProfiles,
			selectedModelOverrideValue: "gpt-5-mini",
		});
		expect(display?.switchCostWarningText).toContain("select claude-sonnet-4");
	});

	it("keeps the warning without recommending an unavailable profile", () => {
		const display = buildActionModelDisplay({
			modelPreview: preview({
				resolvedModel: { ...resolvedModel, modelProfileId: "gpt-5-mini" },
			}),
			availableProfiles: availableProfiles.map((profile) =>
				profile.id.startsWith("claude")
					? { ...profile, availability: "unavailable" as const }
					: profile,
			),
			selectedModelOverrideValue: "",
		});
		expect(display?.switchCostWarningText).toContain("No equivalent selectable profile");
	});

	it("suppresses a cached preview after its expiry", () => {
		const display = buildActionModelDisplay({
			modelPreview: preview({
				resolvedModel: { ...resolvedModel, modelProfileId: "gpt-5-mini" },
			}),
			availableProfiles,
			selectedModelOverrideValue: "",
			now: Date.parse("2099-01-01T00:00:00.001Z"),
		});
		expect(display?.switchCostWarningText).toBeNull();
	});

	it("suppresses warnings without warm cache context", () => {
		const display = buildActionModelDisplay({
			modelPreview: preview({ warmPromptCache: undefined }),
			availableProfiles,
			selectedModelOverrideValue: "gpt-5-mini",
		});
		expect(display?.switchCostWarningText).toBeNull();
	});

	it("shows a deferred preview note when action input is incomplete", () => {
		const display = buildActionModelDisplay({
			modelPreview: {
				kind: "unavailable",
				turnId: null,
				description: null,
				unavailableReason: "invalid_action_input",
				unavailableMessage: "Field 'message' is required",
			},
			availableProfiles,
			selectedModelOverrideValue: "",
		});
		expect(display?.helperTone).toBe("muted");
		expect(display?.helperText).toContain("Fill in the action inputs");
	});

	it("surfaces model-resolution errors inline", () => {
		const display = buildActionModelDisplay({
			modelPreview: preview({
				resolvedModel: {
					status: "error",
					modelProfileId: null,
					source: null,
					error: "resolver exploded",
				},
			}),
			availableProfiles,
			selectedModelOverrideValue: "gpt-5-mini",
		});
		expect(display?.helperTone).toBe("error");
		expect(display?.helperText).toContain("resolver exploded");
	});
});
