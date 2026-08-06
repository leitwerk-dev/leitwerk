import type { DurableModelSelection, TurnStartRecord } from "@leitwerk-dev/domain";
import { trimToNull } from "@leitwerk-dev/domain";
import type {
	ExistingTurnSelection,
	ModelConfiguration,
	ModelOverride,
	PolicyProcess,
	PolicySnapshot,
	ProcessModelAvailabilitySnapshot,
	ProcessModelPolicyEvaluation,
	ValidModelConfiguration,
} from "./types.js";
import { provenanceKindForSource } from "./types.js";

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
	if (policy.allowedProfileIds && !policy.allowedProfileIds.has(profile.id))
		return {
			ok: false,
			code: "model_profile_not_allowed",
			modelProfileId: profile.id,
			processId,
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
		| "catalog_default",
): DurableModelSelection | null {
	const id = trimToNull(modelProfileId);
	return id
		? { modelProfileId: id, provenance: { kind: provenanceKindForSource(source), source } }
		: null;
}

function isValidCandidate(
	snapshot: PolicySnapshot,
	policy: PolicyProcess,
	profileId: string,
): boolean {
	return (
		snapshot.profilesById.has(profileId) &&
		(!policy.allowedProfileIds || policy.allowedProfileIds.has(profileId))
	);
}

function resolvedDefault(
	snapshot: PolicySnapshot,
	configuration: ValidModelConfiguration,
): DurableModelSelection | null {
	const policy = processPolicy(snapshot, configuration.processId);
	const instanceDefault = candidate(configuration.defaultProfileId, "instance_default");
	if (instanceDefault) return instanceDefault;
	for (const current of [
		candidate(policy.defaultProfileId, "process_config_default"),
		...snapshot.profiles.map((profile) => candidate(profile.id, "catalog_default")),
	]) {
		if (current && isValidCandidate(snapshot, policy, current.modelProfileId)) return current;
	}
	return null;
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

function resolveInherited(
	snapshot: PolicySnapshot,
	configuration: ValidModelConfiguration,
	turnId: string,
): DurableModelSelection | null {
	const policy = processPolicy(snapshot, configuration.processId);
	const instanceTurn = candidate(configuration.turnProfileIds.get(turnId), "instance_turn_config");
	if (instanceTurn) return instanceTurn;
	const processTurn = candidate(policy.turnProfileIds[turnId], "process_config_turn");
	if (processTurn && isValidCandidate(snapshot, policy, processTurn.modelProfileId))
		return processTurn;
	const instanceDefault = candidate(configuration.defaultProfileId, "instance_default");
	if (instanceDefault) return instanceDefault;
	return resolvedDefault(snapshot, configuration);
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
			candidate(purposeProfileId, "process_config_default"),
			availability,
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
	if (override.kind === "clear")
		return validateSelection(snapshot, configuration.processId, null, availability);
	if (override.kind === "profile")
		return validateSelection(
			snapshot,
			configuration.processId,
			{
				modelProfileId: override.profileId,
				provenance: { kind: "explicit", source: override.source },
			},
			availability,
		);
	if (
		existingSelection.kind === "selected" &&
		(mode === "initial" || mode === "retry" || mode === "continue") &&
		existingSelection.turnId === turnId &&
		existingSelection.selection.provenance.kind === "explicit"
	)
		return validateSelection(
			snapshot,
			configuration.processId,
			existingSelection.selection,
			availability,
		);
	return validateSelection(
		snapshot,
		configuration.processId,
		resolveInherited(snapshot, configuration, turnId),
		availability,
	);
}

export function recoverPreparation(
	snapshot: PolicySnapshot,
	cause: "availability_transition" | "startup_reconciliation",
	configuration: ModelConfiguration,
	existingSelection: ExistingTurnSelection,
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
	if (provenance?.kind === "inherited") {
		return resolveTurn(
			snapshot,
			configuration,
			currentStart.turnId,
			"retry",
			existingSelection,
			{ kind: "inherit" },
			availability,
		);
	}
	return validateSelection(
		snapshot,
		configuration.processId,
		profileId && provenance ? { modelProfileId: profileId, provenance } : null,
		availability,
	);
}
