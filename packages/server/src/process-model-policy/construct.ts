import { trimToNull } from "@leitwerk-dev/domain";
import { isLlmTurnDefinition } from "@leitwerk-dev/process-sdk";
import type { LeitwerkConfig } from "../config/config-types.js";
import type { ProcessActionRegistry } from "../process-action-registry.js";
import { getProcessGraph, type ProcessGraphRegistry } from "../process-graph.js";
import type { PolicyProcess, PolicyProfile, PolicySnapshot } from "./types.js";

export interface ProcessModelPolicyConfigurationIssue {
	readonly code: "unknown_llm_turn";
	readonly processId: string;
	readonly turnId: string;
}

export class ProcessModelPolicyConfigurationError extends Error {
	readonly issues: readonly ProcessModelPolicyConfigurationIssue[];

	constructor(issues: readonly ProcessModelPolicyConfigurationIssue[]) {
		super("Invalid process model policy configuration");
		this.name = "ProcessModelPolicyConfigurationError";
		this.issues = issues;
	}
}

export function constructPolicySnapshot(input: {
	config: LeitwerkConfig;
	processGraphs: ProcessGraphRegistry;
	processActionRegistry: Pick<ProcessActionRegistry, "getTurnDefinition">;
}): PolicySnapshot {
	const configSnapshot = structuredClone(input.config);
	const profiles: PolicyProfile[] = configSnapshot.pi.model_profiles.map((profile) => ({
		id: profile.id,
		provider: profile.provider,
		modelId: profile.model_id,
		thinkingLevel: profile.thinking_level ?? "off",
		providerOptions: profile.provider_options ?? {},
	}));
	const processIds = new Set([
		...input.processGraphs.keys(),
		...Object.keys(configSnapshot.process_configs ?? {}),
	]);
	const processesById = new Map<string, PolicyProcess>();
	for (const processId of processIds) {
		const graph = input.processGraphs.has(processId)
			? getProcessGraph(input.processGraphs, processId)
			: null;
		const config = configSnapshot.process_configs?.[processId];
		const llmTurnIds = new Set<string>();
		const purposeProfileIdsByTurn: Record<string, string> = {};
		const descriptions: Record<string, string> = {};
		const pathTypes: Record<string, string> = {};
		for (const [turnId, turn] of graph?.turns ?? []) {
			if (turn.turnType !== "llm") continue;
			llmTurnIds.add(turnId);
			const definition = input.processActionRegistry.getTurnDefinition(processId, turnId);
			pathTypes[turnId] =
				definition && isLlmTurnDefinition(definition) ? definition.branchType : "primary";
			if (definition && isLlmTurnDefinition(definition) && definition.modelPurpose) {
				const purposeProfileId = trimToNull(
					configSnapshot.pi[definition.modelPurpose].model_profile,
				);
				if (purposeProfileId) purposeProfileIdsByTurn[turnId] = purposeProfileId;
			}
			descriptions[turnId] =
				definition && isLlmTurnDefinition(definition)
					? (trimToNull(definition.description) ?? turnId)
					: turnId;
		}
		const allowed = config?.allowed_model_profiles
			? new Set(config.allowed_model_profiles.map((id) => id.trim()).filter(Boolean))
			: null;
		processesById.set(processId, {
			id: processId,
			allowedProfileIds: allowed,
			defaultProfileId: trimToNull(config?.default_model_profile),
			turnProfileIds: Object.fromEntries(
				Object.entries(config?.turn_configs ?? {}).map(([turnId, turnConfig]) => [
					turnId,
					trimToNull(turnConfig.model_profile),
				]),
			),
			llmTurnIds,
			purposeProfileIdsByTurn,
			turnDescriptions: descriptions,
			turnPathTypes: pathTypes,
		});
	}
	const configurationIssues: ProcessModelPolicyConfigurationIssue[] = [];
	for (const [processId, processConfig] of Object.entries(configSnapshot.process_configs ?? {})) {
		const llmTurnIds = processesById.get(processId)?.llmTurnIds ?? new Set();
		for (const turnId of Object.keys(processConfig.turn_configs ?? {})) {
			if (!llmTurnIds.has(turnId)) {
				configurationIssues.push({ code: "unknown_llm_turn", processId, turnId });
			}
		}
	}
	if (configurationIssues.length > 0)
		throw new ProcessModelPolicyConfigurationError(configurationIssues);
	return {
		profiles,
		profilesById: new Map(profiles.map((profile) => [profile.id, profile])),
		processesById,
		workerStaticConfig: {
			pi: configSnapshot.pi,
			workers: configSnapshot.workers,
			processPi: Object.fromEntries(
				Object.entries(configSnapshot.process_configs ?? {}).map(([id, value]) => [
					id,
					value.pi ?? null,
				]),
			),
		},
	};
}
