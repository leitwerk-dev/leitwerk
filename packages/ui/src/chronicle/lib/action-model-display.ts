import { trimToNull } from "@leitwerk-dev/domain";
import { resolvePromptCacheSwitch } from "@leitwerk-dev/protocol/http-contracts";
import type {
	ModelProfileOptionSummary,
	ProcessActionModelPreview,
	ProcessActionModelResolutionPreview,
} from "../../lib/api.js";

export interface ActionModelDisplay {
	blankOptionLabel: string;
	helperText: string | null;
	helperTone: "muted" | "error";
	switchCostWarningText: string | null;
}

function findModelProfile(
	availableProfiles: readonly ModelProfileOptionSummary[],
	modelProfileId: string | null,
): ModelProfileOptionSummary | null {
	if (!modelProfileId) return null;
	return availableProfiles.find((profile) => profile.id === modelProfileId) ?? null;
}

function describeModel(profile: ModelProfileOptionSummary | null, modelProfileId: string): string {
	const label = profile?.label?.trim() ?? "";
	if (label !== "") {
		const [shortLabel] = label.split(" — ");
		if (shortLabel?.trim()) return shortLabel.trim();
	}
	return modelProfileId;
}

function describeModelSource(
	source: Exclude<ProcessActionModelResolutionPreview["source"], null>,
): string {
	switch (source) {
		case "instance_turn_config":
			return "launch turn override";
		case "process_config_turn":
			return "config-file turn override";
		case "instance_default":
			return "launch default";
		case "process_config_default":
			return "config-file default";
		case "action_override":
			return "operator override";
		case "persisted_selection":
			return "saved turn selection";
		case "catalog_default":
			return "catalog default";
		case "none":
			return "unresolved default";
	}
}

function emptyDisplay(input: {
	helperText: string;
	helperTone: "muted" | "error";
}): ActionModelDisplay {
	return {
		blankOptionLabel: "Use selected/default model",
		helperText: input.helperText,
		helperTone: input.helperTone,
		switchCostWarningText: null,
	};
}

function buildUnavailableDisplay(
	preview: Extract<ProcessActionModelPreview, { kind: "unavailable" }>,
): ActionModelDisplay {
	if (preview.unavailableReason === "invalid_action_input") {
		return emptyDisplay({
			helperText: "Fill in the action inputs to preview the resolved model.",
			helperTone: "muted",
		});
	}
	return emptyDisplay({
		helperText: preview.unavailableMessage ?? "The server couldn't preview the next-turn model.",
		helperTone: "error",
	});
}

export function buildActionModelDisplay(input: {
	modelPreview: ProcessActionModelPreview | null;
	availableProfiles: readonly ModelProfileOptionSummary[];
	selectedModelOverrideValue: string | null | undefined;
	now?: number;
}): ActionModelDisplay | null {
	const preview = input.modelPreview;
	if (!preview || preview.kind === "not_applicable") return null;
	if (preview.kind === "unavailable") return buildUnavailableDisplay(preview);

	const resolvedModel = preview.resolvedModel;
	const selectedModelOverrideValue = trimToNull(input.selectedModelOverrideValue);
	if (!resolvedModel || resolvedModel.status === "error") {
		return emptyDisplay({
			helperText:
				resolvedModel?.error ?? "The server couldn't resolve the model this action would use.",
			helperTone: "error",
		});
	}
	if (resolvedModel.status === "none" || !resolvedModel.modelProfileId) {
		return emptyDisplay({
			helperText: "No model is currently resolved for this turn.",
			helperTone: "muted",
		});
	}

	const resolvedProfile = findModelProfile(input.availableProfiles, resolvedModel.modelProfileId);
	const resolvedModelDescription = describeModel(resolvedProfile, resolvedModel.modelProfileId);
	const effectiveModelProfileId = selectedModelOverrideValue ?? resolvedModel.modelProfileId;
	const cacheSwitch = resolvePromptCacheSwitch({
		context: preview.warmPromptCache,
		effectiveModelProfileId,
		selectableModelProfileIds: input.availableProfiles
			.filter((profile) => !profile.availability || profile.availability === "available")
			.map((profile) => profile.id),
		now: input.now,
	});
	const recommendedProfileId = cacheSwitch.recommendedModelProfileId;
	const switchCostWarningText = cacheSwitch.switchingModelMayBypassPromptCache
		? recommendedProfileId
			? `Switching models may lose prompt-cache reuse, so costs may increase. To keep using the previous model, select ${describeModel(findModelProfile(input.availableProfiles, recommendedProfileId), recommendedProfileId)}.`
			: "Switching models may lose prompt-cache reuse, so costs may increase. No equivalent selectable profile is currently available."
		: null;

	return {
		blankOptionLabel: `Use selected/default model (${resolvedModelDescription})`,
		helperText: `Resolved model: ${resolvedModelDescription} from ${describeModelSource(resolvedModel.source as Exclude<ProcessActionModelResolutionPreview["source"], null>)}.`,
		helperTone: "muted",
		switchCostWarningText,
	};
}
