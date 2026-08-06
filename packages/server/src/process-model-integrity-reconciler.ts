import type { ProcessInstance } from "@leitwerk-dev/domain";
import type { RepositoryBundle } from "./db/repositories.js";
import type { ProcessEngine } from "./process-engine/types.js";
import type { ServerProcessModelPolicy } from "./process-model-policy/index.js";

interface LoggerLike {
	info?: (...args: unknown[]) => void;
	warn?: (...args: unknown[]) => void;
}

function isClosed(process: ProcessInstance): boolean {
	return process.lifecycleStatus === "completed" || process.lifecycleStatus === "aborted";
}

/** Parks intrinsically malformed durable model state without rewriting model choices. */
export async function reconcilePersistedProcessModelIntegrity(input: {
	processes: RepositoryBundle["processes"];
	commands: Pick<ProcessEngine, "parkProcessLifecycle">;
	policy: ServerProcessModelPolicy;
	logger?: LoggerLike;
}): Promise<void> {
	let parkedCount = 0;
	for (const process of input.processes.listAll()) {
		if (isClosed(process) || process.lifecycleStatus === "error") continue;
		const integrity = input.policy.inspectPersistedState(process);
		if (integrity.kind === "valid") continue;

		const issueCodes = integrity.issues.map((issue) => issue.code);
		const result = await input.commands.parkProcessLifecycle(process.id, {
			reason: `Persisted model state is malformed (${issueCodes.join(", ")})`,
		});
		if (result.ok) {
			parkedCount += 1;
			input.logger?.warn?.(
				{ instanceId: process.id, processId: process.processId, issues: integrity.issues },
				"Parked malformed persisted process model state during startup",
			);
		} else {
			input.logger?.warn?.(
				{ instanceId: process.id, processId: process.processId, issues: integrity.issues, result },
				"Failed to park malformed persisted process model state during startup",
			);
		}
	}
	input.logger?.info?.(
		{ parkedCount },
		"Persisted process model integrity reconciliation complete",
	);
}
