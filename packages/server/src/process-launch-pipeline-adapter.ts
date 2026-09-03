import type { LaunchCommit, LaunchStageFailure } from "./launch-pipeline.js";
import type { ProcessLaunchExecutionResult } from "./process-launch-executor.js";

export function toLaunchPipelineCommit<TFailure, TResult = ProcessLaunchExecutionResult>(
	created: ProcessLaunchExecutionResult,
	input: {
		startTurnId: string | null;
		preCommitSummary: string;
		postCommitSummary: string;
		mapPreCommitFailure(
			created: Extract<ProcessLaunchExecutionResult, { ok: false; stage: "pre_commit" }>,
		): TFailure;
		mapCommittedResult?(
			created: Exclude<ProcessLaunchExecutionResult, { stage: "pre_commit" }>,
		): TResult;
	},
): LaunchCommit<TResult, TFailure> {
	const mapResult = (value: Exclude<ProcessLaunchExecutionResult, { stage: "pre_commit" }>) =>
		input.mapCommittedResult?.(value) ?? (value as TResult);
	if (!created.ok && created.stage === "pre_commit") {
		return {
			kind: "failed",
			failure: {
				safeSummary: input.preCommitSummary,
				value: input.mapPreCommitFailure(created),
			} satisfies LaunchStageFailure<TFailure>,
		};
	}
	if (!created.ok) {
		return {
			kind: "committed_with_reaction_error",
			result: mapResult(created),
			process: created.process,
			startTurnId: input.startTurnId,
			safeSummary: input.postCommitSummary,
		};
	}
	return {
		kind: "committed",
		result: mapResult(created),
		process: created.process,
		startTurnId: input.startTurnId,
		reused: created.reused,
	};
}
