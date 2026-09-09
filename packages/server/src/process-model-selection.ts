import { type ProcessInstance, type ProcessProject, trimToNull } from "@leitwerk-dev/domain";
import {
	isLlmTurnDefinition,
	type ProcessModelSelectionServiceLike,
} from "@leitwerk-dev/process-sdk";
import type { ParsedInstanceTree } from "./instance-tree.js";
import type { ModelStatusCache } from "./model-providers/model-status-cache.js";
import { buildProcessActionNextTurnModelSummary } from "./process-action-next-turn-model.js";
import { planProcessAction } from "./process-action-planner.js";
import type { ProcessActionRegistry } from "./process-action-registry.js";
import type { ProcessGraphRegistry } from "./process-graph.js";
import type { ServerProcessModelPolicy } from "./process-model-policy/index.js";
import {
	presentModelProfileOption,
	presentProcessModelPolicyFailure,
} from "./process-model-policy-presenter.js";
import type { ProcessTurnRecordLookup, TurnStartRecordLookup } from "./turn-result-markdown.js";

export interface ProcessModelSelectionDeps {
	processGraphs: ProcessGraphRegistry;
	processActionRegistry: ProcessActionRegistry;
	processes: { getById(id: string): ProcessInstance | null };
	projects: { listByInstance(instanceId: string): readonly ProcessProject[] };
	scheduledActions: {
		getScheduledActionByInstance(instanceId: string): { actionId: string | null } | null;
	};
	turnRecords: ProcessTurnRecordLookup;
	turnStarts: TurnStartRecordLookup;
	instanceTrees: {
		readInstanceTree(instanceId: string): Promise<ParsedInstanceTree>;
	};
	processModelPolicy: ServerProcessModelPolicy;
	modelStatusCache: Pick<ModelStatusCache, "snapshot">;
}

export function createProcessModelSelection(
	deps: ProcessModelSelectionDeps,
): ProcessModelSelectionServiceLike {
	return {
		listAvailableProfiles(instanceId) {
			const process = deps.processes.getById(instanceId);
			if (!process) return null;
			return deps.processModelPolicy
				.project({
					kind: "profile_options",
					processId: process.processId,
					availability: deps.modelStatusCache.snapshot(),
				})
				.map(presentModelProfileOption);
		},

		async preview(instanceId, actionId, actionInput) {
			const process = deps.processes.getById(instanceId);
			if (!process) return { kind: "operational_failure", code: "process_not_found" };

			const projects = deps.projects.listByInstance(instanceId);
			const scheduledAction = deps.scheduledActions.getScheduledActionByInstance(instanceId);
			const availability = deps.modelStatusCache.snapshot();
			let tree: ParsedInstanceTree;
			try {
				tree = await deps.instanceTrees.readInstanceTree(instanceId);
			} catch {
				return { kind: "operational_failure", code: "instance_tree_unavailable" };
			}

			const planned = await planProcessAction({
				processGraphs: deps.processGraphs,
				processActionRegistry: deps.processActionRegistry,
				process,
				projects,
				turnRecords: deps.turnRecords,
				actionId,
				actionInput,
				allowHiddenTurnScopedAction: scheduledAction?.actionId === actionId,
				requirePurePlan: true,
			});
			if (!planned.ok) {
				return {
					kind: "unavailable",
					turnId: null,
					description: null,
					unavailableReason: planned.code,
					unavailableMessage: planned.error,
				};
			}

			const turnId = planned.candidateSelectedTurnId;
			if (!turnId) return { kind: "not_applicable", turnId: null, description: null };

			const candidateTurnDef = deps.processActionRegistry.getTurnDefinition(
				process.processId,
				turnId,
			);
			if (!candidateTurnDef || !isLlmTurnDefinition(candidateTurnDef)) {
				return {
					kind: "not_applicable",
					turnId,
					description: trimToNull(candidateTurnDef?.description) ?? turnId,
				};
			}

			const policyResult = deps.processModelPolicy.evaluate({
				kind: "process_turn",
				process: planned.candidateProcess,
				turnId,
				availability,
			});
			const nextTurnModel = buildProcessActionNextTurnModelSummary({
				process: planned.candidateProcess,
				candidateTurnDef,
				entryExists: (entryId) => tree.entriesById.has(entryId),
				turnRecords: deps.turnRecords,
				turnStarts: deps.turnStarts,
				resolveCompatibleModelProfileIds: (providerId, modelId) =>
					deps.processModelPolicy.project({
						kind: "compatible_profiles",
						availability,
						processId: process.processId,
						providerId,
						modelId,
					}),
				resolvedModel: {
					status: policyResult.ok ? (policyResult.selection ? "resolved" : "none") : "error",
					modelProfileId: policyResult.selection?.modelProfileId ?? null,
					source: policyResult.selection?.provenance.source ?? null,
					error: policyResult.ok ? null : presentProcessModelPolicyFailure(policyResult),
				},
			});
			return {
				kind: "llm_turn",
				turnId,
				description: trimToNull(candidateTurnDef.description) ?? turnId,
				resolvedModel: nextTurnModel.resolvedModel,
				warmPromptCache: nextTurnModel.warmPromptCache,
			};
		},
	};
}
