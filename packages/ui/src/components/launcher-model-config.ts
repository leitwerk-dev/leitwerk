import type {
	LauncherDefaultModelPreview,
	LauncherModelConfigPreview,
	LauncherTurnModelConfigPreview,
	ModelProfileOptionSummary,
} from "../lib/api.js";

export type LauncherModelCustomizationMode =
	| "recommended"
	| "default_only"
	| "turn_overrides_only"
	| "mixed";

export type LauncherModelDisplayState =
	| "recommended"
	| "custom"
	| "use_process_default"
	| "missing";

export type LauncherModelSummaryMode = "recommended" | "adjusted";

export interface LauncherModelCustomizationState {
	mode: LauncherModelCustomizationMode;
	hasCustomizations: boolean;
	hasProcessDefault: boolean;
	turnOverrideCount: number;
	totalCustomizedChoices: number;
}

type LauncherModelLineSource =
	| LauncherDefaultModelPreview["source"]
	| LauncherTurnModelConfigPreview["effective"]["source"];

export interface LauncherModelDisplayLine {
	kind: "default" | "turn";
	label: string;
	turnId: string | null;
	state: LauncherModelDisplayState;
	source: LauncherModelLineSource;
	profile: ModelProfileOptionSummary | null;
	modelName: string | null;
	statusLabel: string;
}

export interface LauncherModelSummaryTurn {
	turnId: string;
	label: string;
	source: LauncherTurnModelConfigPreview["effective"]["source"];
	profile: ModelProfileOptionSummary | null;
	modelName: string | null;
	isAdjusted: boolean;
}

export interface LauncherModelSummaryView {
	mode: LauncherModelSummaryMode;
	statusLabel: string;
	turns: LauncherModelSummaryTurn[];
}

export function countTurnModelOverrides(values: Record<string, string>): number {
	return Object.values(values).filter((value) => value.trim() !== "").length;
}

export function getLauncherModelCustomizationState(input: {
	defaultModelProfileId: string;
	turnModelProfileIds: Record<string, string>;
}): LauncherModelCustomizationState {
	const hasProcessDefault = input.defaultModelProfileId.trim() !== "";
	const turnOverrideCount = countTurnModelOverrides(input.turnModelProfileIds);
	const totalCustomizedChoices = turnOverrideCount + (hasProcessDefault ? 1 : 0);

	let mode: LauncherModelCustomizationMode = "recommended";
	if (hasProcessDefault && turnOverrideCount > 0) {
		mode = "mixed";
	} else if (hasProcessDefault) {
		mode = "default_only";
	} else if (turnOverrideCount > 0) {
		mode = "turn_overrides_only";
	}

	return {
		mode,
		hasCustomizations: totalCustomizedChoices > 0,
		hasProcessDefault,
		turnOverrideCount,
		totalCustomizedChoices,
	};
}

function isAdjustedTurnSource(
	source: LauncherTurnModelConfigPreview["effective"]["source"],
): boolean {
	return source === "instance_turn_config";
}

export function getDefaultModelBlankOptionLabel(
	recommendedProfile: ModelProfileOptionSummary | null | undefined,
): string {
	const modelName = getModelDisplayName(recommendedProfile);
	return modelName ? `Recommended (${modelName})` : "Recommended";
}

export function getDefaultModelSelectableProfiles(input: {
	availableProfiles: readonly ModelProfileOptionSummary[];
	recommendedProfile: ModelProfileOptionSummary | null | undefined;
}): readonly ModelProfileOptionSummary[] {
	const recommendedProfileId = input.recommendedProfile?.id.trim() ?? "";
	if (recommendedProfileId === "") {
		return input.availableProfiles;
	}
	return input.availableProfiles.filter((option) => option.id !== recommendedProfileId);
}

export function getTurnModelBlankOptionLabel(): string {
	return "Use process default";
}

function getModelDisplayName(profile: ModelProfileOptionSummary | null | undefined): string | null {
	if (!profile) {
		return null;
	}
	const preferredValue = profile.id.trim();
	if (preferredValue !== "") {
		return preferredValue;
	}
	const fallbackValue = profile.label.trim();
	return fallbackValue !== "" ? fallbackValue : null;
}

function isTurnUsingProcessDefault(source: LauncherModelLineSource): boolean {
	return source === "instance_default" || source === "process_config_default";
}

function isRecommendedTurnSource(source: LauncherModelLineSource): boolean {
	return source === "process_config_turn" || source === "catalog_default";
}

export function formatLauncherModelSummaryStatus(mode: LauncherModelSummaryMode): string {
	return mode === "adjusted" ? "Uses adjusted models" : "Use recommended models";
}

export function formatLauncherModelDisplayValue(line: LauncherModelDisplayLine): string {
	if (line.kind === "default") {
		switch (line.source) {
			case "instance_default":
				return `Custom for this launch (${line.modelName ?? "unknown model"})`;
			case "process_config_default":
				return `Process default (${line.modelName ?? "unknown model"})`;
			case "catalog_default":
				return `Recommended (${line.modelName ?? "unknown model"})`;
			default:
				return "No model available";
		}
	}

	switch (line.source) {
		case "instance_turn_config":
			return `Custom (${line.modelName ?? "unknown model"})`;
		case "instance_default":
		case "process_config_default":
			return "Use process default";
		case "process_config_turn":
		case "catalog_default":
			return `Recommended (${line.modelName ?? "unknown model"})`;
		default:
			return "No model available";
	}
}

export function describeDefaultModelDisplayLine(
	preview: LauncherDefaultModelPreview | null,
): LauncherModelDisplayLine {
	const source = preview?.source ?? "none";
	const profile = preview?.profile ?? null;
	if (!profile) {
		return {
			kind: "default",
			label: "Default model",
			turnId: null,
			state: "missing",
			source,
			profile: null,
			modelName: null,
			statusLabel: "No model available",
		};
	}
	const state = source === "instance_default" ? "custom" : "recommended";
	const line: LauncherModelDisplayLine = {
		kind: "default",
		label: "Default model",
		turnId: null,
		state,
		source,
		profile,
		modelName: getModelDisplayName(profile),
		statusLabel: "",
	};
	return { ...line, statusLabel: formatLauncherModelDisplayValue(line) };
}

export function describeTurnModelDisplayLine(input: {
	turnId: string;
	description: string;
	effective: LauncherTurnModelConfigPreview["effective"] | null;
	defaultLine: LauncherModelDisplayLine;
}): LauncherModelDisplayLine {
	const source = input.effective?.source ?? "none";
	const profile = input.effective?.profile ?? null;
	if (!profile) {
		return {
			kind: "turn",
			label: input.description,
			turnId: input.turnId,
			state: "missing",
			source,
			profile: null,
			modelName: null,
			statusLabel: "No model available",
		};
	}

	let state: LauncherModelDisplayState;
	if (source === "instance_turn_config") {
		state = "custom";
	} else if (isTurnUsingProcessDefault(source)) {
		state = "use_process_default";
	} else if (isRecommendedTurnSource(source)) {
		state = "recommended";
	} else {
		state = "missing";
	}

	const line: LauncherModelDisplayLine = {
		kind: "turn",
		label: input.description,
		turnId: input.turnId,
		state,
		source,
		profile,
		modelName: getModelDisplayName(profile),
		statusLabel: "",
	};
	return { ...line, statusLabel: formatLauncherModelDisplayValue(line) };
}

export function buildLauncherModelSummaryView(input: {
	preview: LauncherModelConfigPreview | null;
	hasCustomizations: boolean;
}): LauncherModelSummaryView {
	const mode: LauncherModelSummaryMode = input.hasCustomizations ? "adjusted" : "recommended";
	return {
		mode,
		statusLabel: formatLauncherModelSummaryStatus(mode),
		turns: (input.preview?.turns ?? []).map((turn) => ({
			turnId: turn.turnId,
			label: turn.description,
			source: turn.effective.source,
			profile: turn.effective.profile,
			modelName: getModelDisplayName(turn.effective.profile),
			isAdjusted: isAdjustedTurnSource(turn.effective.source),
		})),
	};
}
