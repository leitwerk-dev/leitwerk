import type { FutureExecution } from "@leitwerk-dev/domain";
import type { RepositoryBundle } from "../db/repositories.js";
import type { PostCommitEffect } from "../effects/post-commit-effect.js";
import type { ModelStatusCacheSnapshot } from "../model-providers/model-status-cache.js";
import type { ProcessActionRegistry } from "../process-action-registry.js";
import type { ProcessGraphRegistry } from "../process-graph.js";
import {
	evaluateAtStableAvailabilityRevision,
	type ServerProcessModelPolicy,
} from "../process-model-policy/index.js";
import type { ProcessOperationCoordinator } from "../process-operation-coordinator.js";
import type { ProcessTitleGenerator } from "../process-title-generator.js";
import type { Broadcaster } from "../ws/broadcast.js";
import {
	projectFutureExecutionModelState,
	sameModelPolicyState,
	toFutureExecutionBlockReason,
} from "./model-projection.js";
import {
	buildFutureExecutionUpdatedEffect,
	runFutureExecutionExclusive,
	runFutureExecutionPostCommitEffects,
} from "./support.js";

/** Revalidates durable future blocks after startup or an availability transition. */
export async function reconcileFutureExecutionModelBlocks(input: {
	futureExecutions: Pick<RepositoryBundle["futureExecutions"], "listAll" | "getById" | "update">;
	processes: Pick<RepositoryBundle["processes"], "getById">;
	projects: Pick<RepositoryBundle["projects"], "listByInstance">;
	turnRecords: RepositoryBundle["turnRecords"];
	processGraphs: ProcessGraphRegistry;
	processActionRegistry: ProcessActionRegistry;
	processOperations: ProcessOperationCoordinator;
	policy: ServerProcessModelPolicy;
	availability: ModelStatusCacheSnapshot;
	getModelAvailabilitySnapshot: () => ModelStatusCacheSnapshot;
	profileIds?: ReadonlySet<string>;
	broadcaster: Broadcaster;
	processTitles?: ProcessTitleGenerator;
	asOf: string;
}) {
	let changed = 0;
	const effects: PostCommitEffect[] = [];
	for (const candidate of input.futureExecutions.listAll()) {
		if (
			candidate.modelSelection &&
			input.profileIds &&
			!input.profileIds.has(candidate.modelSelection.modelProfileId)
		) {
			continue;
		}
		await runFutureExecutionExclusive(input.processOperations, candidate.id, async () => {
			const found = input.futureExecutions.getById(candidate.id);
			if (!found) return;
			let current: FutureExecution = found;
			let availability = input.availability;
			const updateCurrent = (
				id: string,
				patch: Parameters<typeof input.futureExecutions.update>[1],
			): FutureExecution | null => {
				const updated = input.futureExecutions.update(id, patch);
				if (!updated) return null;
				current = updated;
				changed += 1;
				effects.push(buildFutureExecutionUpdatedEffect(updated, "updated"));
				return updated;
			};
			const parkStaleEvaluation = () => {
				const blockedReason = toFutureExecutionBlockReason(
					{
						ok: false,
						code: "stale_evaluation_snapshot",
						selection: current.modelSelection ?? null,
						availabilityRevision: availability.revision,
					},
					input.asOf,
					current.blockedReason,
				);
				if (sameModelPolicyState(current, { ...current, blockedReason })) return;
				updateCurrent(current.id, { blockedReason });
			};
			const evaluateStable = async <T>(
				evaluate: (snapshot: ModelStatusCacheSnapshot) => T | Promise<T>,
			) => {
				const evaluation = await evaluateAtStableAvailabilityRevision({
					availability,
					getModelAvailabilitySnapshot: input.getModelAvailabilitySnapshot,
					evaluate,
				});
				availability = evaluation.availability;
				return evaluation;
			};
			const projectCurrent = async (): Promise<"stale" | "unchanged" | "updated"> => {
				const evaluation = await evaluateStable((snapshot) =>
					projectFutureExecutionModelState({ ...input, availability: snapshot }, current),
				);
				if (!evaluation.ok) {
					parkStaleEvaluation();
					return "stale";
				}
				const projected = evaluation.value;
				if (!projected || sameModelPolicyState(current, projected)) return "unchanged";
				return updateCurrent(current.id, projected) ? "updated" : "unchanged";
			};

			if (!current.modelSelection) {
				if ((await projectCurrent()) === "stale" || !current.modelSelection) return;
			}

			const validation = await evaluateStable((snapshot) =>
				input.policy.evaluate({
					kind: "runtime_selection",
					availability: snapshot,
					processId: current.processId,
					selection: current.modelSelection ?? null,
				}),
			);
			if (!validation.ok) {
				parkStaleEvaluation();
				return;
			}
			const result = validation.value;
			const inheritedInvalid =
				!result.ok &&
				current.modelSelection.provenance.kind === "inherited" &&
				(result.code === "unknown_model_profile" || result.code === "model_profile_not_allowed");
			if (inheritedInvalid) {
				await projectCurrent();
				return;
			}
			const blockedReason = toFutureExecutionBlockReason(result, input.asOf, current.blockedReason);
			if (sameModelPolicyState(current, { ...current, blockedReason })) return;
			updateCurrent(current.id, { blockedReason });
		});
	}
	const reaction = await runFutureExecutionPostCommitEffects(input, effects);
	return { changed, reaction };
}
