import type { LaunchPlanPreparationIssue } from "@leitwerk-dev/process-sdk";
import type {
	LauncherModelConfigPreview,
	LauncherModelConfigSchema,
	ModelProfileOptionSummary,
	ProcessModelConfigurationView,
} from "@leitwerk-dev/protocol/http-contracts";
import type {
	ProcessModelPolicyEvaluation,
	ProjectedLauncherModelPreview,
	ProjectedLauncherModelSchema,
	ProjectedModelProfile,
	ProjectedProcessModelConfiguration,
} from "./process-model-policy/index.js";

type ProcessModelPolicyFailure = Exclude<ProcessModelPolicyEvaluation, { ok: true }>;

export function presentLaunchPlanPreparationIssues(
	issues: readonly LaunchPlanPreparationIssue[],
): readonly { code: "invalid_model_config"; message: string }[] {
	return issues.map((issue) => ({
		code: "invalid_model_config" as const,
		message: issue.message,
	}));
}

export function presentProcessModelPolicyFailure(failure: ProcessModelPolicyFailure): string {
	switch (failure.code) {
		case "model_required":
			return "Choose a model before starting this turn";
		case "unknown_model_profile":
			return `Unknown model profile '${failure.modelProfileId}'`;
		case "model_profile_not_allowed":
			return `Model profile '${failure.modelProfileId}' is not allowed for process '${failure.processId}'`;
		case "model_stale":
			return failure.reason ?? "Model status has not been refreshed";
		case "model_unavailable":
			return failure.reason ?? "The selected model is unavailable";
		case "invalid_model_configuration":
			return failure.source === "selection_provenance"
				? "Persisted model selection provenance is invalid"
				: "Persisted model configuration is invalid";
		case "stale_evaluation_snapshot":
			return "Model availability changed repeatedly during evaluation";
	}
}

export function presentModelProfileOption(
	profile: ProjectedModelProfile,
): ModelProfileOptionSummary {
	const thinkingLevel = profile.thinkingLevel.trim();
	return {
		id: profile.id,
		label: `${profile.id} — ${profile.providerId}/${profile.modelId}`,
		description:
			thinkingLevel && thinkingLevel.toLowerCase() !== "off"
				? `Thinking level: ${thinkingLevel}`
				: "Thinking disabled",
		availability: profile.availability,
		safeReason: profile.safeReason ?? "Model status has not been refreshed",
		checkedAt: profile.checkedAt,
	};
}

export function presentLauncherModelConfigSchema(
	projection: ProjectedLauncherModelSchema,
): LauncherModelConfigSchema {
	return {
		availableProfiles: projection.profiles.map(presentModelProfileOption),
		llmTurns: projection.turns.map((turn) => ({ ...turn })),
	};
}

export function presentLauncherModelConfigPreview(
	projection: ProjectedLauncherModelPreview,
): LauncherModelConfigPreview {
	return {
		defaultModel: {
			source:
				projection.defaultModel.source === "instance"
					? "instance_default"
					: projection.defaultModel.source === "process_config"
						? "process_config_default"
						: projection.defaultModel.source,
			profile: projection.defaultModel.profile
				? presentModelProfileOption(projection.defaultModel.profile)
				: null,
		},
		turns: projection.turns.map((turn) => ({
			turnId: turn.turnId,
			description: turn.description,
			effective: {
				source: turn.effective.source,
				profile: turn.effective.profile ? presentModelProfileOption(turn.effective.profile) : null,
			},
		})),
	};
}

export function presentProcessModelConfiguration(
	projection: ProjectedProcessModelConfiguration,
): ProcessModelConfigurationView {
	return {
		state: projection.state,
		availableProfiles: projection.profiles.map(presentModelProfileOption),
		effectiveSelectedTurn: projection.effectiveSelectedTurn,
		defaultModel: projection.defaultModel,
		turns: projection.turns,
	};
}
