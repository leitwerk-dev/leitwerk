import type { DurableModelSelection, TurnStartRecord } from "@leitwerk-dev/domain";
import { trimToNull } from "@leitwerk-dev/domain";
import { profileRejections, rankedProfiles, requirementLayers } from "./requirements.js";
import type {
	ExistingTurnSelection,
	ModelConfiguration,
	ModelOverride,
	PolicyProcess,
	PolicySnapshot,
	ProcessModelAvailabilitySnapshot,
	ProcessModelPolicyEvaluation,
	SkippedModelPreference,
	ValidModelConfiguration,
} from "./types.js";
import { isPinnedModelSelection, provenanceKindForSource } from "./types.js";

function processPolicy(snapshot: PolicySnapshot, processId: string): PolicyProcess {
	return (
		snapshot.processesById.get(processId) ?? {
			id: processId,
			allowedProfileIds: null,
			defaultProfileId: null,
			turnProfileIds: {},
			llmTurnIds: new Set(),
			purposeProfileIdsByTurn: {},
			turnDescriptions: {},
			turnPathTypes: {},
		}
	);
}

export function validateSelection(
	snapshot: PolicySnapshot,
	processId: string,
	selection: DurableModelSelection | null,
	availability?: ProcessModelAvailabilitySnapshot,
	turnId?: string,
): ProcessModelPolicyEvaluation {
	if (!selection)
		return {
			ok: false,
			code: "model_required",
			selection: null,
			...(availability ? { availabilityRevision: availability.revision } : {}),
		};
	const profile = snapshot.profilesById.get(selection.modelProfileId);
	if (!profile)
		return {
			ok: false,
			code: "unknown_model_profile",
			modelProfileId: selection.modelProfileId,
			selection,
			...(availability ? { availabilityRevision: availability.revision } : {}),
		};
	const policy = processPolicy(snapshot, processId);
	const rejections = profileRejections(policy, profile, turnId);
	if (rejections.length)
		return {
			ok: false,
			code: "model_profile_not_allowed",
			modelProfileId: profile.id,
			processId,
			rejections,
			selection,
			...(availability ? { availabilityRevision: availability.revision } : {}),
		};
	if (availability) {
		const status = availability.profiles.find((candidate) => candidate.profileId === profile.id);
		if (!status || status.availability !== "available") {
			const stale = !status || status.availability === "stale";
			return {
				ok: false,
				code: stale ? "model_stale" : "model_unavailable",
				reason: status?.safeReason ?? null,
				selection,
				availabilityRevision: availability.revision,
			};
		}
	}
	return {
		ok: true,
		selection,
		...(availability ? { availabilityRevision: availability.revision } : {}),
	};
}

function candidate(
	modelProfileId: string | null | undefined,
	source:
		| "instance_turn_config"
		| "process_config_turn"
		| "instance_default"
		| "process_config_default"
		| "catalog_default"
		| "scoped_purpose_default"
		| "marked_default"
		| "automatic"
		| "fixed_purpose",
): DurableModelSelection | null {
	const id = trimToNull(modelProfileId);
	return id
		? { modelProfileId: id, provenance: { kind: provenanceKindForSource(source), source } }
		: null;
}

function resolvedDefault(
	snapshot: PolicySnapshot,
	configuration: ValidModelConfiguration,
): DurableModelSelection | null {
	const policy = processPolicy(snapshot, configuration.processId);
	const instanceDefault = candidate(configuration.defaultProfileId, "instance_default");
	if (instanceDefault) return instanceDefault;
	const configured = candidate(policy.defaultProfileId, "process_config_default");
	if (configured) return configured;
	return candidate(snapshot.defaultProfileId, "catalog_default");
}

export function resolveDefault(
	snapshot: PolicySnapshot,
	configuration: ValidModelConfiguration,
	availability?: ProcessModelAvailabilitySnapshot,
): ProcessModelPolicyEvaluation {
	return validateSelection(
		snapshot,
		configuration.processId,
		resolvedDefault(snapshot, configuration),
		availability,
	);
}

function invalidConfiguration(
	configuration: Extract<ModelConfiguration, { kind: "invalid" }>,
): ProcessModelPolicyEvaluation {
	return {
		ok: false,
		code: "invalid_model_configuration",
		source: "configuration",
		selection: null,
		issues: configuration.issues,
	};
}

export function resolveTurn(
	snapshot: PolicySnapshot,
	configuration: ModelConfiguration,
	turnId: string,
	mode: "resolve" | "initial" | "retry" | "continue",
	existingSelection: ExistingTurnSelection,
	override: ModelOverride,
	availability?: ProcessModelAvailabilitySnapshot,
): ProcessModelPolicyEvaluation {
	const policy = processPolicy(snapshot, configuration.processId);
	if (!policy.llmTurnIds.has(turnId)) return { ok: true, selection: null };
	if (configuration.kind === "invalid") return invalidConfiguration(configuration);
	// A configured code-defined purpose is authoritative over launch/action overrides.
	const purposeProfileId = policy.purposeProfileIdsByTurn[turnId];
	if (purposeProfileId)
		return validateSelection(
			snapshot,
			configuration.processId,
			candidate(purposeProfileId, "fixed_purpose"),
			availability,
			turnId,
		);
	if (existingSelection.kind === "invalid" && existingSelection.turnId === turnId)
		return {
			ok: false,
			code: "invalid_model_configuration",
			source: "selection_provenance",
			selection: null,
			issues: existingSelection.issues,
			...(availability ? { availabilityRevision: availability.revision } : {}),
		};
	if (override.kind === "clear") {
		existingSelection = { kind: "none" };
	}
	if (override.kind === "profile")
		return validateSelection(
			snapshot,
			configuration.processId,
			{
				modelProfileId: override.profileId,
				provenance: { kind: "explicit", source: override.source },
			},
			availability,
			turnId,
		);
	if (
		existingSelection.kind === "selected" &&
		(mode === "initial" || mode === "retry" || mode === "continue") &&
		existingSelection.turnId === turnId &&
		isPinnedModelSelection(existingSelection.selection)
	)
		return validateSelection(
			snapshot,
			configuration.processId,
			existingSelection.selection,
			availability,
			turnId,
		);
	try {
		const skippedPreferences: SkippedModelPreference[] = [];
		const explain = (result: ProcessModelPolicyEvaluation): ProcessModelPolicyEvaluation => ({
			...result,
			skippedPreferences,
		});
		const preferences = [
			() => candidate(configuration.turnProfileIds.get(turnId), "instance_turn_config"),
			() => candidate(configuration.defaultProfileId, "instance_default"),
			() => candidate(policy.scopedProfileIdForTurn?.(turnId), "scoped_purpose_default"),
			() => candidate(policy.turnProfileIds[turnId], "process_config_turn"),
			() => candidate(policy.defaultProfileId, "process_config_default"),
			() => candidate(snapshot.defaultProfileId, "catalog_default"),
		];
		for (const getPreference of preferences) {
			const preference = getPreference();
			if (!preference) continue;
			const eligibility = validateSelection(
				snapshot,
				configuration.processId,
				preference,
				undefined,
				turnId,
			);
			if (
				!eligibility.ok &&
				eligibility.code === "model_profile_not_allowed" &&
				preference.provenance.source !== "instance_turn_config"
			) {
				skippedPreferences.push({
					profileId: preference.modelProfileId,
					source: preference.provenance.source,
					rejections: eligibility.rejections ?? [],
				});
				continue;
			}
			if (!eligibility.ok) return explain(eligibility);
			return explain(
				validateSelection(snapshot, configuration.processId, preference, availability, turnId),
			);
		}
		const ranked = rankedProfiles(policy, snapshot.profiles, turnId);
		if (!ranked.profiles.length)
			return {
				ok: false,
				code: "model_required",
				selection: null,
				skippedPreferences,
				...(availability ? { availabilityRevision: availability.revision } : {}),
				requirements: requirementLayers(policy, turnId),
			};
		return {
			...explain(
				validateSelection(
					snapshot,
					configuration.processId,
					candidate(ranked.profiles[0]?.id, ranked.marked ? "marked_default" : "automatic"),
					availability,
					turnId,
				),
			),
			ranking: {
				kind: ranked.marked ? "marked_defaults" : "cost_id",
				tiedProfileIds: ranked.tiedProfileIds,
			},
		};
	} catch (error) {
		return {
			ok: false,
			code: "invalid_model_configuration",
			source: "configuration",
			selection: null,
			issues: [],
			message: error instanceof Error ? error.message : "Invalid scoped settings",
		};
	}
}

export function recoverPreparation(
	snapshot: PolicySnapshot,
	cause: "availability_transition" | "startup_reconciliation",
	configuration: ModelConfiguration,
	_existingSelection: ExistingTurnSelection,
	currentStart: TurnStartRecord,
	availability: ProcessModelAvailabilitySnapshot,
): ProcessModelPolicyEvaluation {
	const state = currentStart.state;
	if (
		state.kind !== "preparation_failed" ||
		(state.code !== "model_unavailable" && state.code !== "model_stale") ||
		state.availabilityRevision === undefined ||
		(cause === "availability_transition" && state.availabilityRevision >= availability.revision)
	)
		return {
			ok: false,
			code: "model_unavailable",
			reason: "This start is not eligible for automatic model recovery",
			selection: null,
			availabilityRevision: availability.revision,
		};
	const profileId = trimToNull(state.requestedModelProfileId);
	const provenance = state.modelSelectionProvenance;
	return validateSelection(
		snapshot,
		configuration.processId,
		profileId && provenance ? { modelProfileId: profileId, provenance } : null,
		availability,
		currentStart.turnId,
	);
}
