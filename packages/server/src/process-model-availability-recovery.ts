import type { RepositoryBundle } from "./db/repositories.js";
import type { ModelStatusCacheSnapshot } from "./model-providers/model-status-cache.js";
import type { ProcessEngine } from "./process-engine/types.js";
import type { ServerProcessModelPolicy } from "./process-model-policy/index.js";

/**
 * Replaces only current, unaccepted starts parked by model availability. The
 * ProcessEngine operation supplies per-process coordination and current-start
 * rejection, making repeated transition/startup scans idempotent.
 */
export async function recoverModelAvailabilityFailures(input: {
	processes: Pick<RepositoryBundle["processes"], "listAll">;
	turnStarts: Pick<RepositoryBundle["turnStarts"], "getById">;
	commands: Pick<ProcessEngine, "retryStartup">;
	policy: ServerProcessModelPolicy;
	availability: ModelStatusCacheSnapshot;
	cause: "availability_transition" | "startup_reconciliation";
	profileIds?: ReadonlySet<string>;
	logger?: { warn(payload: Record<string, unknown>, message: string): void };
}): Promise<number> {
	let recovered = 0;
	for (const process of input.processes.listAll()) {
		if (process.lifecycleStatus !== "error" || process.currentExecution?.kind !== "worker_start") {
			continue;
		}
		const start = input.turnStarts.getById(process.currentExecution.id);
		if (!start || start.state.kind !== "preparation_failed") continue;
		if (start.state.code !== "model_unavailable" && start.state.code !== "model_stale") continue;
		if (
			input.profileIds &&
			start.state.modelSelectionProvenance?.kind !== "inherited" &&
			(!start.state.requestedModelProfileId ||
				!input.profileIds.has(start.state.requestedModelProfileId))
		) {
			continue;
		}
		const evaluation = input.policy.evaluate({
			kind: "preparation_recovery",
			cause: input.cause,
			process,
			currentStart: start,
			availability: input.availability,
		});
		if (!evaluation.ok || !evaluation.selection) continue;
		const result = await input.commands.retryStartup(process.id, start.id);
		if (result.ok) recovered += 1;
		else if (result.code !== "stale_turn_start" && result.code !== "stale_startup_target") {
			input.logger?.warn(
				{ instanceId: process.id, startRecordId: start.id, code: result.code },
				"Model availability recovery was rejected",
			);
		}
	}
	return recovered;
}
