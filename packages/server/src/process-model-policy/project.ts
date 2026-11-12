import { trimToNull } from "@leitwerk-dev/domain";
import { compareModelProfileIds, modelCostRank } from "@leitwerk-dev/protocol";
import { presentProcessModelPolicyFailure } from "../process-model-policy-presenter.js";
import { resolveDefault, resolveTurn } from "./evaluate.js";
import {
	existingTurnSelectionFromProcess,
	modelConfigurationFromLaunchInput,
	modelConfigurationFromProcess,
} from "./input.js";
import { profileRejections } from "./requirements.js";
import type {
	PolicySnapshot,
	ProcessModelPolicyProjectionByKind,
	ProcessModelPolicyProjectionKind,
	ProcessModelPolicyProjectionSubject,
	ProcessModelPolicyProjectionSubjectFor,
	ProjectedModelDefault,
	ValidModelConfiguration,
} from "./types.js";

function defaultProjection(
	snapshot: PolicySnapshot,
	configuration: ValidModelConfiguration,
): ProjectedModelDefault {
	const policy = snapshot.processesById.get(configuration.processId);
	const { selection } = resolveDefault(snapshot, configuration);
	return {
		processConfigModelProfileId: trimToNull(policy?.defaultProfileId),
		instanceModelProfileId: configuration.defaultProfileId ?? null,
		effectiveModelProfileId: selection?.modelProfileId ?? null,
		source:
			selection?.provenance.source === "instance_default"
				? "instance"
				: selection?.provenance.source === "process_config_default"
					? "process_config"
					: selection
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
	const policy = snapshot.processesById.get(processId);
	const targetTurnId =
		"target" in request && request.target.kind === "turn" ? request.target.turnId : undefined;
	if (request.kind === "compatible_profiles") {
		return snapshot.profiles
			.filter(
				(profile) =>
					profile.provider === request.providerId &&
					profile.modelId === request.modelId &&
					(!policy || !profileRejections(policy, profile, targetTurnId).length),
			)
			.map((profile) => profile.id);
	}
	const catalog = [...snapshot.profiles]
		.sort(
			(a, b) =>
				modelCostRank(a.labels) - modelCostRank(b.labels) || compareModelProfileIds(a.id, b.id),
		)
		.map((profile) => {
			const status = request.availability?.profiles.find(
				(candidate) => candidate.profileId === profile.id,
			);
			return {
				source: profile,
				id: profile.id,
				providerId: profile.provider,
				modelId: profile.modelId,
				thinkingLevel: profile.thinkingLevel,
				labels: profile.labels,
				default: profile.default,
				availability: status?.availability ?? ("stale" as const),
				safeReason: status?.safeReason ?? null,
				checkedAt: status?.checkedAt ?? null,
			};
		});
	const projectProfiles = (turnId?: string) => {
		const projected = catalog.map(({ source, ...option }) => {
			const rejections = policy ? profileRejections(policy, source, turnId) : [];
			return {
				...option,
				policyReason:
					rejections.map((r) => `${r.code} (${r.values.join(", ")}) from ${r.origin}`).join("; ") ||
					undefined,
			};
		});
		return {
			profiles: projected.filter((profile) => !profile.policyReason),
			excludedProfiles: projected.filter((profile) => profile.policyReason),
		};
	};
	const processProfiles = projectProfiles(targetTurnId);
	const { profiles } = processProfiles;

	if (request.kind === "profile_options") return profiles;

	const profileMaps = () => {
		const turns = [...(policy?.llmTurnIds ?? [])].map(
			(turnId) => [turnId, projectProfiles(turnId)] as const,
		);
		return {
			profilesByTurn: Object.fromEntries(turns.map(([id, value]) => [id, value.profiles])),
			excludedProfiles: Object.fromEntries([
				["", processProfiles.excludedProfiles],
				...turns.map(([id, value]) => [id, value.excludedProfiles]),
			]),
		};
	};
	if (request.kind === "launcher_schema") {
		return {
			...profileMaps(),
			profiles,
			turns: [...(policy?.llmTurnIds ?? [])].map((turnId) => ({
				turnId,
				description: policy?.turnDescriptions[turnId] ?? turnId,
			})),
		};
	}

	const configuration =
		request.kind === "launcher_preview"
			? modelConfigurationFromLaunchInput(processId, request.modelConfig)
			: modelConfigurationFromProcess(request.process);
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
		const resolved = resolveTurn(
			snapshot,
			configuration,
			turnId,
			false,
			{ kind: "none" },
			{ kind: "inherit" },
			request.availability,
		);
		return {
			turnId,
			explanation: resolved.skippedPreferences?.length
				? `Automatic — skipped ${resolved.skippedPreferences.map((preference) => `${preference.profileId}: ${preference.rejections.map((r) => `${r.code} (${r.values.join(", ")}) from ${r.origin}`).join("; ")}`).join("; ")}`
				: undefined,
			ranking: resolved.ranking,
			effectiveModelProfileId: resolved.selection?.modelProfileId ?? null,
			effectiveSource: resolved.selection?.provenance.source ?? ("none" as const),
			...(!resolved.ok ? { effectiveError: presentProcessModelPolicyFailure(resolved) } : {}),
			description: policy?.turnDescriptions[turnId] ?? turnId,
			pathType: policy?.turnPathTypes[turnId] ?? "primary",
			processConfigModelProfileId,
			instanceModelProfileId,
			fixedModelProfileId: policy?.purposeProfileIdsByTurn[turnId] ?? null,
			effectiveConfiguredModelProfileId:
				policy?.purposeProfileIdsByTurn[turnId] ??
				instanceModelProfileId ??
				processConfigModelProfileId,
			source: instanceModelProfileId
				? ("instance" as const)
				: processConfigModelProfileId
					? ("process_config" as const)
					: ("default" as const),
		};
	});

	if (request.kind === "launcher_preview") {
		const profilesById = new Map(
			catalog.map(({ source: _source, ...profile }) => [profile.id, profile]),
		);
		return {
			defaultModel: {
				source: defaultModel.source,
				profile: profilesById.get(defaultModel.effectiveModelProfileId ?? "") ?? null,
			},
			turns: turns.map((turn) => ({
				turnId: turn.turnId,
				description: turn.description,
				effective: {
					explanation: turn.explanation,
					ranking: turn.ranking,
					source: turn.effectiveSource,
					...(turn.effectiveError ? { error: turn.effectiveError } : {}),
					profile: profilesById.get(turn.effectiveModelProfileId ?? "") ?? null,
				},
			})),
		};
	}

	const selectedTurn = existingTurnSelectionFromProcess(request.process);
	return {
		state: { kind: "ready" },
		...profileMaps(),
		profiles,
		defaultModel,
		turns,
		effectiveSelectedTurn:
			selectedTurn.kind === "selected"
				? {
						turnId: selectedTurn.turnId,
						description: policy?.turnDescriptions[selectedTurn.turnId] ?? selectedTurn.turnId,
						modelProfileId: selectedTurn.selection.modelProfileId,
						source: selectedTurn.selection.provenance.source,
					}
				: null,
	};
}
