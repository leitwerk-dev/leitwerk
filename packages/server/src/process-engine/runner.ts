import type { ProcessInstance } from "@leitwerk-dev/domain";
import { type DecideResult, type Decision, type RejectedDecision, reject } from "./decision.js";
import {
	logProcessEngineError,
	publicEngineFailureMessage,
	publicInternalEngineFailureMessage,
} from "./internal-failures.js";
import type {
	OperationData,
	OperationInput,
	OperationInputBase,
	OperationMessages,
	OperationRunOptions,
	OperationSpec,
} from "./operation.js";
import { dispatchReactions } from "./reactions.js";
import { record } from "./recorder.js";
import type { EngineFailure, EngineResult, ProcessEngineDeps, RecordedDecision } from "./types.js";

function resolveMessages<TOp extends OperationSpec<string, OperationInputBase, unknown>>(
	operation: TOp,
	input: OperationInput<TOp>,
): OperationMessages {
	if (!operation.messages) {
		return {};
	}
	return typeof operation.messages === "function" ? operation.messages(input) : operation.messages;
}

function shouldReportBestEffortFailures<
	TOp extends OperationSpec<string, OperationInputBase, unknown>,
>(operation: TOp, input: OperationInput<TOp>): boolean {
	return typeof operation.reportBestEffortFailures === "function"
		? operation.reportBestEffortFailures(input)
		: operation.reportBestEffortFailures === true;
}

function mapPreCommitFailure<T>(
	failure: RejectedDecision<T>,
	initialProcess: EngineFailure<T>["process"],
): EngineFailure<T> {
	return {
		ok: false,
		code: failure.code,
		message: publicEngineFailureMessage({
			code: failure.code,
			message: failure.message,
			stage: "pre_commit",
		}),
		...(initialProcess ? { process: initialProcess } : {}),
		...(failure.data !== undefined ? { data: failure.data } : {}),
		stage: "pre_commit",
	};
}

function mapPostCommitFailure<T>(
	recorded: RecordedDecision<OperationSpec<string, OperationInputBase, T>>,
	failure: { code: string; message: string },
): EngineFailure<T> {
	return {
		ok: false,
		code: failure.code,
		message: publicEngineFailureMessage({
			code: failure.code,
			message: failure.message,
			stage: "post_commit",
		}),
		process: recorded.process,
		data: recorded.data,
		...(recorded.turnSelectionChange ? { turnSelectionChange: recorded.turnSelectionChange } : {}),
		stage: "post_commit",
	};
}

function mapSuccess<T>(recorded: RecordedDecision<OperationSpec<string, OperationInputBase, T>>) {
	return {
		ok: true as const,
		process: recorded.process,
		data: recorded.data,
		...(recorded.turnSelectionChange ? { turnSelectionChange: recorded.turnSelectionChange } : {}),
	};
}

export function createEngineRunner(
	deps: ProcessEngineDeps,
	options: {
		afterSuccess?: (instanceId: string) => Promise<void>;
	} = {},
) {
	return async function run<TOp extends OperationSpec<string, OperationInputBase, unknown>>(
		operation: TOp,
		input: OperationInput<TOp>,
		runOptions: OperationRunOptions<OperationData<TOp>> = {},
	): Promise<EngineResult<OperationData<TOp>>> {
		/**
		 * Engine invariant: one operation for a process instance is serialized from
		 * decision through durable recording. Reactions are intentionally dispatched
		 * after runExclusive(...) returns, so broadcasts, worker supervision, input
		 * dispatch, and extension events cannot deadlock the process lock.
		 */
		type LockedOutcome =
			| {
					kind: "pre_commit_failed";
					failure: RejectedDecision<OperationData<TOp>>;
					initialProcess: ProcessInstance | null;
			  }
			| {
					kind: "post_commit_failed";
					failure: { code: string; message: string };
					recorded: RecordedDecision<TOp>;
			  }
			| { kind: "recorded"; recorded: RecordedDecision<TOp> };

		const lockedOutcome = await deps.processOperations.runExclusive(
			input.instanceId,
			async (): Promise<LockedOutcome> => {
				const process = deps.processes.getById(input.instanceId);
				if (!process) {
					return {
						kind: "pre_commit_failed",
						failure: reject("process_not_found", "Process not found"),
						initialProcess: null,
					};
				}

				let decision: DecideResult<OperationData<TOp>>;
				try {
					decision = (await operation.decide(
						{
							deps,
							instanceId: input.instanceId,
							process,
						},
						input,
					)) as DecideResult<OperationData<TOp>>;
				} catch (error) {
					logProcessEngineError(deps.logger, {
						err: error,
						operationKind: operation.kind,
						instanceId: input.instanceId,
						stage: "pre_commit",
						code: "operation_failed",
					});
					return {
						kind: "pre_commit_failed",
						failure: reject(
							"operation_failed",
							publicInternalEngineFailureMessage("operation_failed", "pre_commit"),
						),
						initialProcess: process,
					};
				}

				if (!decision.ok) {
					return {
						kind: "pre_commit_failed",
						failure: decision as RejectedDecision<OperationData<TOp>>,
						initialProcess: process,
					};
				}

				try {
					const recordResult = await record(
						deps,
						operation,
						input,
						process,
						decision as Decision<OperationData<TOp>>,
					);
					if (!recordResult.ok) {
						if (recordResult.stage === "post_commit") {
							return {
								kind: "post_commit_failed",
								failure: {
									code: recordResult.code,
									message: recordResult.message,
								},
								recorded: recordResult.recorded,
							};
						}
						return {
							kind: "pre_commit_failed",
							failure: reject(recordResult.code, recordResult.message),
							initialProcess: process,
						};
					}
					return { kind: "recorded", recorded: recordResult.recorded };
				} catch (error) {
					logProcessEngineError(deps.logger, {
						err: error,
						operationKind: operation.kind,
						instanceId: input.instanceId,
						stage: "pre_commit",
						code: "record_failed",
					});
					return {
						kind: "pre_commit_failed",
						failure: reject(
							"record_failed",
							publicInternalEngineFailureMessage("record_failed", "pre_commit"),
						),
						initialProcess: process,
					};
				}
			},
		);

		if (lockedOutcome.kind === "pre_commit_failed") {
			return mapPreCommitFailure(lockedOutcome.failure, lockedOutcome.initialProcess);
		}
		if (lockedOutcome.kind === "post_commit_failed") {
			return mapPostCommitFailure(
				lockedOutcome.recorded as RecordedDecision<
					OperationSpec<string, OperationInputBase, OperationData<TOp>>
				>,
				lockedOutcome.failure,
			);
		}

		const { recorded } = lockedOutcome;
		try {
			runOptions.afterRecord?.(recorded.data);
		} catch (error) {
			logProcessEngineError(deps.logger, {
				err: error,
				operationKind: operation.kind,
				instanceId: input.instanceId,
				stage: "post_commit",
				code: "after_record_callback_failed",
			});
		}
		try {
			await deps.afterRecord?.(recorded.process);
		} catch (error) {
			logProcessEngineError(deps.logger, {
				err: error,
				operationKind: operation.kind,
				instanceId: input.instanceId,
				stage: "post_commit",
				code: "post_commit_failed",
			});
			return mapPostCommitFailure(
				recorded as RecordedDecision<OperationSpec<string, OperationInputBase, OperationData<TOp>>>,
				{
					code: "post_commit_failed",
					message: publicInternalEngineFailureMessage("post_commit_failed", "post_commit"),
				},
			);
		}

		let dispatchResult: Awaited<ReturnType<typeof dispatchReactions>>;
		try {
			dispatchResult = await dispatchReactions(deps, recorded, resolveMessages(operation, input), {
				reportBestEffortFailures: shouldReportBestEffortFailures(operation, input),
			});
		} catch (error) {
			logProcessEngineError(deps.logger, {
				err: error,
				operationKind: operation.kind,
				instanceId: input.instanceId,
				stage: "post_commit",
				code: "post_commit_failed",
			});
			dispatchResult = {
				ok: false,
				code: "post_commit_failed",
				message: publicInternalEngineFailureMessage("post_commit_failed", "post_commit"),
			};
		}

		if (!dispatchResult.ok) {
			return mapPostCommitFailure(
				recorded as RecordedDecision<OperationSpec<string, OperationInputBase, OperationData<TOp>>>,
				dispatchResult,
			);
		}

		try {
			await options.afterSuccess?.(input.instanceId);
		} catch (error) {
			logProcessEngineError(deps.logger, {
				err: error,
				operationKind: operation.kind,
				instanceId: input.instanceId,
				stage: "post_commit",
				code: "post_commit_failed",
			});
			return mapPostCommitFailure(
				recorded as RecordedDecision<OperationSpec<string, OperationInputBase, OperationData<TOp>>>,
				{
					code: "post_commit_failed",
					message: publicInternalEngineFailureMessage("post_commit_failed", "post_commit"),
				},
			);
		}

		return mapSuccess(
			recorded as RecordedDecision<OperationSpec<string, OperationInputBase, OperationData<TOp>>>,
		);
	};
}
