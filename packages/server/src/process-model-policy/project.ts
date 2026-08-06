import { type ProcessSelectedTurnModelSource, trimToNull } from "@leitwerk-dev/domain";
import { resolveTurn } from "./evaluate.js";
import {
	existingTurnSelectionFromProcess,
	modelConfigurationFromLaunchInput,
	modelConfigurationFromProcess,
} from "./input.js";
import type {
	PolicySnapshot,
	ProcessModelAvailabilitySnapshot,
	ProcessModelPolicyProjectionByKind,
	ProcessModelPolicyProjectionKind,
	ProcessModelPolicyProjectionSubject,
	ProcessModelPolicyProjectionSubjectFor,
	ProjectedModelDefault,
	ProjectedModelProfile,
	ProjectedModelResolutionSource,
	ValidModelConfiguration,
} from "./types.js";

function projectProfiles(
	snapshot: PolicySnapshot,
	processId: string,
	availability?: ProcessModelAvailabilitySnapshot,
): readonly ProjectedModelProfile[] {
	const process = snapshot.processesById.get(processId);
	return snapshot.profiles
		.filter((profile) => !process?.allowedProfileIds || process.allowedProfileIds.has(profile.id))
		.map((profile) => {
			const status = availability?.profiles.find((candidate) => candidate.profileId === profile.id);
			return {
				id: profile.id,
				providerId: profile.provider,
				modelId: profile.modelId,
				thinkingLevel: profile.thinkingLevel,
				availability: status?.availability ?? "stale",
				safeReason: status?.safeReason ?? null,
				checkedAt: status?.checkedAt ?? null,
			};
		});
}

function sourceForPreview(
	source: ProcessSelectedTurnModelSource | undefined,
): ProjectedModelResolutionSource {
	return source === "action_override" ? "instance_turn_config" : (source ?? "none");
}

function defaultProjection(
	snapshot: PolicySnapshot,
	configuration: ValidModelConfiguration,
): ProjectedModelDefault {
	const policy = snapshot.processesById.get(configuration.processId);
	const processConfigId = trimToNull(policy?.defaultProfileId);
	const catalogId =
		snapshot.profiles.find(
			(profile) => !policy?.allowedProfileIds || policy.allowedProfileIds.has(profile.id),
		)?.id ?? null;
	const instanceId = configuration.defaultProfileId ?? null;
	const effective = instanceId ?? processConfigId ?? catalogId;
	return {
		processConfigModelProfileId: processConfigId,
		instanceModelProfileId: instanceId,
		effectiveModelProfileId: effective,
		source: instanceId
			? "instance"
			: processConfigId
				? "process_config"
				: catalogId
					? "catalog_default"
					: "none",
	};
}

export function projectPolicy<K extends ProcessModelPolicyProjectionKind>(
	snapshot: PolicySnapshot,
	request: ProcessModelPolicyProjectionSubjectFor<K>,
): ProcessModelPolicyProjectionByKind[K];
export function projectPolicy(
	snapshot: PolicySnapshot,
	request: ProcessModelPolicyProjectionSubject,
): ProcessModelPolicyProjectionByKind[ProcessModelPolicyProjectionKind] {
	const processId =
		request.kind === "process_configuration" ? request.process.processId : request.processId;
	const profiles = projectProfiles(
		snapshot,
		processId,
		"availability" in request ? request.availability : undefined,
	);

	if (request.kind === "profile_options") return profiles;

	if (request.kind === "compatible_profiles") {
		const allowedProfileIds = new Set(profiles.map((profile) => profile.id));
		return snapshot.profiles
			.filter(
				(profile) =>
					profile.provider === request.providerId &&
					profile.modelId === request.modelId &&
					allowedProfileIds.has(profile.id),
			)
			.map((profile) => profile.id);
	}

	const policy = snapshot.processesById.get(processId);
	if (request.kind === "launcher_schema") {
		return {
			profiles,
			turns: [...(policy?.llmTurnIds ?? [])].map((turnId) => ({
				turnId,
				description: policy?.turnDescriptions[turnId] ?? turnId,
			})),
		};
	}

	if (request.kind === "launcher_preview") {
		const configuration = modelConfigurationFromLaunchInput(processId, request.modelConfig);
		const defaultModel = defaultProjection(snapshot, configuration);
		const profilesById = new Map(profiles.map((profile) => [profile.id, profile]));
		return {
			defaultModel: {
				source: defaultModel.source,
				profile: defaultModel.effectiveModelProfileId
					? (profilesById.get(defaultModel.effectiveModelProfileId) ?? null)
					: null,
			},
			turns: [...(policy?.llmTurnIds ?? [])].map((turnId) => {
				const result = resolveTurn(
					snapshot,
					configuration,
					turnId,
					"resolve",
					{ kind: "none" },
					{ kind: "inherit" },
					request.availability,
				);
				return {
					turnId,
					description: policy?.turnDescriptions[turnId] ?? turnId,
					effective: {
						source: sourceForPreview(result.selection?.provenance.source),
						profile: result.selection
							? (profilesById.get(result.selection.modelProfileId) ?? null)
							: null,
					},
				};
			}),
		};
	}

	const configuration = modelConfigurationFromProcess(request.process);
	const selectedTurn = existingTurnSelectionFromProcess(request.process);
	if (configuration.kind === "invalid") {
		return {
			state: { kind: "blocked", issues: configuration.issues },
			profiles,
			defaultModel: {
				processConfigModelProfileId: null,
				instanceModelProfileId: null,
				effectiveModelProfileId: null,
				source: "none",
			},
			turns: [],
			effectiveSelectedTurn: null,
		};
	}

	const defaultModel = defaultProjection(snapshot, configuration);
	const turns = [...(policy?.llmTurnIds ?? [])].map((turnId) => {
		const instanceModelProfileId = configuration.turnProfileIds.get(turnId) ?? null;
		const processConfigModelProfileId = trimToNull(policy?.turnProfileIds[turnId]);
		return {
			turnId,
			description: policy?.turnDescriptions[turnId] ?? turnId,
			pathType: policy?.turnPathTypes[turnId] ?? "primary",
			processConfigModelProfileId,
			instanceModelProfileId,
			effectiveConfiguredModelProfileId: instanceModelProfileId ?? processConfigModelProfileId,
			source: instanceModelProfileId
				? ("instance" as const)
				: processConfigModelProfileId
					? ("process_config" as const)
					: ("default" as const),
		};
	});
	const selected =
		selectedTurn.kind === "selected"
			? resolveTurn(
					snapshot,
					configuration,
					selectedTurn.turnId,
					"continue",
					selectedTurn,
					{ kind: "inherit" },
					request.availability,
				)
			: null;
	return {
		state: { kind: "ready" },
		profiles,
		defaultModel,
		turns,
		effectiveSelectedTurn:
			selectedTurn.kind === "selected" && selected?.selection
				? {
						turnId: selectedTurn.turnId,
						description: policy?.turnDescriptions[selectedTurn.turnId] ?? selectedTurn.turnId,
						modelProfileId: selected.selection.modelProfileId,
						source: selected.selection.provenance.source,
					}
				: null,
	};
}
