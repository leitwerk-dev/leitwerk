import {
	type LaunchModelConfigInput,
	type ProcessInstance,
	type ProcessSelectedTurnModelSource,
	parseStrictInstanceTurnConfigsJson,
	trimToNull,
} from "@leitwerk-dev/domain";
import type {
	ExistingTurnSelection,
	ModelConfiguration,
	ModelOverride,
	PersistedModelConfigurationIssue,
	ValidModelConfiguration,
} from "./types.js";
import { provenanceKindForSource } from "./types.js";

type PersistedModelConfigurationInput = Pick<
	ProcessInstance,
	"processId" | "defaultModelProfileId" | "turnConfigsJson"
>;

/** The sole persisted turn-configuration parser for model-policy requests. */
export function modelConfigurationFromPersistedInput(
	input: PersistedModelConfigurationInput,
): ModelConfiguration {
	const parsed = parseStrictInstanceTurnConfigsJson(input.processId, input.turnConfigsJson);
	if (!parsed.ok) {
		const issue: PersistedModelConfigurationIssue = {
			code: parsed.error.code,
			reason: parsed.error.reason,
			...(parsed.error.turnId !== undefined ? { turnId: parsed.error.turnId } : {}),
		};
		return { kind: "invalid", processId: input.processId, issues: [issue] };
	}
	return {
		kind: "valid",
		processId: input.processId,
		defaultProfileId: trimToNull(input.defaultModelProfileId) ?? undefined,
		turnProfileIds: new Map(
			Object.entries(parsed.value).flatMap(([turnId, config]) => {
				const profileId = trimToNull(config.modelProfileId);
				return profileId ? [[turnId, profileId] as const] : [];
			}),
		),
	};
}

export function modelConfigurationFromProcess(process: ProcessInstance): ModelConfiguration {
	return modelConfigurationFromPersistedInput(process);
}

/** Constructs validated configuration from non-persisted launch input. */
export function modelConfigurationFromLaunchInput(
	processId: string,
	modelConfig: LaunchModelConfigInput,
): ValidModelConfiguration {
	return {
		kind: "valid",
		processId,
		defaultProfileId: trimToNull(modelConfig.defaultModelProfileId) ?? undefined,
		turnProfileIds: new Map(
			Object.entries(modelConfig.turnConfigs ?? {}).flatMap(([turnId, config]) => {
				const profileId = trimToNull(config.modelProfileId);
				return profileId ? [[turnId, profileId] as const] : [];
			}),
		),
	};
}

export function existingTurnSelectionFromProcess(process: ProcessInstance): ExistingTurnSelection {
	const profileId = trimToNull(process.selectedTurnModelProfileId);
	// An orphaned profile is stale metadata, not an active selection.
	if (!process.selectedTurnId || !profileId) return { kind: "none" };
	const source = process.selectedTurnModelSource ?? "legacy_persisted";
	const derivedKind = provenanceKindForSource(source);
	if (process.selectedTurnModelKind && process.selectedTurnModelKind !== derivedKind) {
		return {
			kind: "invalid",
			turnId: process.selectedTurnId,
			issues: [
				{
					code: "contradictory_provenance",
					turnId: process.selectedTurnId,
					modelProfileId: profileId,
					kind: process.selectedTurnModelKind,
					source,
				},
			],
		};
	}
	return {
		kind: "selected",
		turnId: process.selectedTurnId,
		selection: {
			modelProfileId: profileId,
			provenance: {
				kind: process.selectedTurnModelKind ?? derivedKind,
				source,
			},
		},
	};
}

export function modelOverride(
	value: string | null | undefined,
	provided: boolean,
	source: Extract<ProcessSelectedTurnModelSource, "action_override" | "launch_override">,
): ModelOverride {
	if (!provided) return { kind: "inherit" };
	const profileId = trimToNull(value);
	return profileId ? { kind: "profile", profileId, source } : { kind: "clear" };
}
