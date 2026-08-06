import type {
	FutureExecution,
	FutureExecutionBlockReason,
	ProcessInstance,
} from "@leitwerk-dev/domain";
import type { ProcessLaunchPlan } from "@leitwerk-dev/process-sdk";
import { parseFutureActionPayloadJson, parseFutureLaunchPayloadJson } from "@leitwerk-dev/protocol";
import type { RepositoryBundle } from "../db/repositories.js";
import type { ModelStatusCacheSnapshot } from "../model-providers/model-status-cache.js";
import { planProcessAction } from "../process-action-planner.js";
import type { ProcessActionRegistry } from "../process-action-registry.js";
import type { ProcessGraphRegistry } from "../process-graph.js";
import type {
	ProcessModelPolicyEvaluation,
	ServerProcessModelPolicy,
} from "../process-model-policy/index.js";
import { presentProcessModelPolicyFailure } from "../process-model-policy-presenter.js";

export interface FutureModelProjectionDeps {
	processes: Pick<RepositoryBundle["processes"], "getById">;
	projects: Pick<RepositoryBundle["projects"], "listByInstance">;
	turnRecords: RepositoryBundle["turnRecords"];
	processGraphs: ProcessGraphRegistry;
	processActionRegistry: ProcessActionRegistry;
	policy: ServerProcessModelPolicy;
	availability: ModelStatusCacheSnapshot;
	now?: () => Date;
}

export type FutureModelSelectionState = Pick<FutureExecution, "modelSelection" | "blockedReason">;

type ModelEvaluationResult = ProcessModelPolicyEvaluation;

export function toFutureExecutionBlockReason(
	result: ModelEvaluationResult,
	detectedAt: string,
	existing?: FutureExecutionBlockReason | null,
): FutureExecutionBlockReason | null {
	if (result.ok) return null;
	return {
		code: result.code,
		selection: result.selection,
		summary: presentProcessModelPolicyFailure(result),
		detectedAt:
			existing?.code === result.code &&
			existing.availabilityRevision === result.availabilityRevision &&
			JSON.stringify(existing.selection) === JSON.stringify(result.selection)
				? existing.detectedAt
				: detectedAt,
		...(result.availabilityRevision !== undefined
			? { availabilityRevision: result.availabilityRevision }
			: {}),
	};
}

function selectionStateFromEvaluation(
	result: ModelEvaluationResult,
	detectedAt: string,
	existingBlockedReason?: FutureExecutionBlockReason | null,
): FutureModelSelectionState {
	return {
		modelSelection: result.selection,
		blockedReason: toFutureExecutionBlockReason(result, detectedAt, existingBlockedReason),
	};
}

export function evaluateFutureModelSelection(input: {
	policy: ServerProcessModelPolicy;
	availability: ModelStatusCacheSnapshot;
	process: ProcessInstance;
	turnId: string | null;
	overrideProvided?: boolean;
	overrideModelProfileId?: string | null;
	detectedAt?: string;
	existingBlockedReason?: FutureExecutionBlockReason | null;
}): FutureModelSelectionState {
	if (!input.turnId) return { modelSelection: null, blockedReason: null };
	const result = input.policy.evaluate({
		kind: "process_turn",
		process: input.process,
		availability: input.availability,
		turnId: input.turnId,
		...(input.overrideProvided ? { modelOverride: input.overrideModelProfileId ?? null } : {}),
	});
	return selectionStateFromEvaluation(
		result,
		input.detectedAt ?? new Date().toISOString(),
		input.existingBlockedReason,
	);
}

export function projectLaunchPlanModelState(
	plan: ProcessLaunchPlan,
	input: {
		policy: ServerProcessModelPolicy;
		availability: ModelStatusCacheSnapshot;
		detectedAt?: string;
		existingBlockedReason?: FutureExecutionBlockReason | null;
	},
): FutureModelSelectionState {
	const turnId = plan.startTurnId ?? plan.processInput.selectedTurnId;
	if (!turnId) return { modelSelection: null, blockedReason: null };
	const result = input.policy.evaluate({
		kind: "launch_plan_turn",
		plan,
		availability: input.availability,
		turnId,
	});
	return selectionStateFromEvaluation(
		result,
		input.detectedAt ?? new Date().toISOString(),
		input.existingBlockedReason,
	);
}

export async function projectFutureExecutionModelState(
	deps: FutureModelProjectionDeps,
	execution: FutureExecution,
) {
	const now = deps.now ?? (() => new Date());
	if (execution.kind === "launch") {
		const parsed = parseFutureLaunchPayloadJson(execution.payloadJson);
		if (!parsed.ok) return null;
		return projectLaunchPlanModelState(parsed.value.launchPlan, {
			policy: deps.policy,
			availability: deps.availability,
			detectedAt: now().toISOString(),
		});
	}
	if (!execution.instanceId || !execution.actionId) return null;
	const parsed = parseFutureActionPayloadJson(execution.payloadJson);
	if (!parsed.ok) return null;
	const process = deps.processes.getById(execution.instanceId);
	if (!process) return null;
	const preflight = await planProcessAction({
		processGraphs: deps.processGraphs,
		processActionRegistry: deps.processActionRegistry,
		process,
		projects: deps.projects.listByInstance(process.id),
		turnRecords: deps.turnRecords,
		actionId: execution.actionId,
		actionInput: parsed.value.input,
		requirePurePlan: true,
	});
	if (!preflight.ok || !preflight.candidateSelectedTurnId) {
		return { modelSelection: null, blockedReason: null };
	}
	return evaluateFutureModelSelection({
		policy: deps.policy,
		availability: deps.availability,
		process: preflight.candidateProcess,
		turnId: preflight.candidateSelectedTurnId,
		overrideModelProfileId: parsed.value.nextTurnModelProfileId,
		overrideProvided: parsed.value.nextTurnModelProfileId !== null,
		detectedAt: now().toISOString(),
	});
}

export function sameModelPolicyState(
	left: Pick<FutureExecution, "modelSelection" | "blockedReason">,
	right: Pick<FutureExecution, "modelSelection" | "blockedReason">,
): boolean {
	return (
		JSON.stringify(left.modelSelection) === JSON.stringify(right.modelSelection) &&
		JSON.stringify(left.blockedReason) === JSON.stringify(right.blockedReason)
	);
}
