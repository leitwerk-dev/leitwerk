import { runPostCommitEffectList } from "../effects/post-commit-runner.js";
import type { OperationInputBase, OperationMessages, OperationSpec } from "./operation.js";
import type { ProcessEngineDeps, RecordedDecision } from "./types.js";

export type ReactionFailureCode =
	| "input_dispatch_failed"
	| "worker_reconcile_failed"
	| "post_commit_failed";

export type ReactionResult =
	| { ok: true }
	| { ok: false; code: ReactionFailureCode; message: string };

export async function dispatchReactions<
	TOp extends OperationSpec<string, OperationInputBase, unknown>,
>(
	deps: ProcessEngineDeps,
	recorded: RecordedDecision<TOp>,
	messages: OperationMessages = {},
	options: { reportBestEffortFailures?: boolean } = {},
): Promise<ReactionResult> {
	/**
	 * Reaction invariant: outside-world work runs only after durable recording and
	 * after the per-process lock has been released. Extension events are reactions;
	 * they are never emitted while the engine holds the process lock.
	 *
	 * Worker/input invariant: worker reconciliation and input dispatch happen here,
	 * after inputs have already been persisted by record(...).
	 */
	const result = await runPostCommitEffectList(
		deps,
		recorded.reactions,
		messages,
		{
			logger: deps.logger,
			operationKind: recorded.operationKind,
			stage: "post_commit",
		},
		options,
	);
	if (result.ok) return result;
	if (result.code === "input_dispatch_failed" || result.code === "worker_reconcile_failed") {
		return { ok: false, code: result.code, message: result.message };
	}
	return { ok: false, code: "post_commit_failed", message: result.message };
}
