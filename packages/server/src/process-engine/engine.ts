import {
	maybeBroadcastActionRequiredToast as maybeBroadcastActionRequiredToastCore,
	maybeBroadcastErrorAttentionToast as maybeBroadcastErrorAttentionToastCore,
} from "../process-attention-notifier.js";
import { broadcastProcessAttentionToast } from "../process-operator-attention.js";
import {
	AbortProcess,
	AbortTurn,
	AcceptWorkerTurnStart,
	ActivateDeferredProcess,
	ContinueFailedTurn,
	ExecuteAction,
	ParkDeferredProcessActivationFailure,
	ParkProcess,
	QueueInputs,
	RetryFailedTurn,
	RetryStartup,
	StartProcess,
	TurnFailed,
	TurnOutcome,
	UpdateProductRefs,
	UpdateSemanticRefs,
	WorkerFailure,
} from "./ops/index.js";
import { createEngineRunner } from "./runner.js";
import type {
	ActionExecutionResult,
	EngineResult,
	ProcessEngine,
	ProcessEngineDeps,
	ProcessTurnSelectionChange,
} from "./types.js";

function buildActionPreCommitFailure(error: string, code?: string): ActionExecutionResult {
	return { ok: false, stage: "pre_commit", error, ...(code ? { code } : {}) };
}

function buildActionPostCommitFailure(
	process: NonNullable<EngineResult<unknown>["process"]>,
	error: string,
	code?: string,
): ActionExecutionResult {
	return { ok: false, stage: "post_commit", process, error, ...(code ? { code } : {}) };
}

function buildActionSuccess(
	process: NonNullable<EngineResult<unknown>["process"]>,
	data?: Record<string, unknown>,
): ActionExecutionResult {
	return { ok: true, process, ...(data ? { data } : {}) };
}

function maybeBroadcastCommittedActionRequiredToast(
	deps: ProcessEngineDeps,
	process: NonNullable<EngineResult<unknown>["process"]> | null | undefined,
	turnSelectionChange: ProcessTurnSelectionChange | undefined,
): void {
	if (!process || !turnSelectionChange || process.lifecycleStatus !== "waiting") {
		return;
	}
	broadcastProcessAttentionToast(
		{
			projects: deps.projects,
			futureExecutions: deps.futureExecutions,
			turnRecords: deps.turnRecords,
			turnStarts: deps.turnStarts,
			processGraphs: deps.processGraphs,
			processActionRegistry: deps.getProcessActionRegistry?.(),
			broadcaster: deps.broadcaster,
			toastTtlMs: deps.toastTtlMs,
		},
		{ process, kind: "action_required" },
	);
}

export function createProcessEngine(deps: ProcessEngineDeps): ProcessEngine {
	let engine: ProcessEngine;
	const run = createEngineRunner(deps, {
		async afterSuccess(instanceId) {
			for (const hook of deps.afterSuccessHooks ?? []) {
				await hook(instanceId);
			}
		},
	});
	const maybeBroadcastActionRequiredToast = <T>(result: EngineResult<T>): EngineResult<T> =>
		maybeBroadcastActionRequiredToastCore(deps, result);
	const maybeBroadcastErrorAttentionToast = <T>(
		result: EngineResult<T>,
		input: { errorCode?: string | null } = {},
	): EngineResult<T> => maybeBroadcastErrorAttentionToastCore(deps, result, input);

	engine = {
		run,

		getDeferredProcessActivationSnapshots({ instanceId, processId, projectKey }) {
			const processes = instanceId
				? [deps.processes.getById(instanceId)].filter((process) => process !== null)
				: deps.processes.listAll().filter((process) => process.processId === processId);
			if (instanceId && processes.length === 0) return { outcome: "process_not_found" };
			const snapshots = processes.flatMap((process) => {
				const project = deps.projects.getByInstanceAndKey(process.id, projectKey);
				return project
					? [
							{
								instanceId: process.id,
								processId: process.processId,
								lifecycleStatus: process.lifecycleStatus,
								selectedTurnId: process.selectedTurnId,
								title: process.title,
								paramsJson: process.paramsJson,
								processMetadata: process.metadata,
								projectId: project.id,
								projectKey: project.key,
								repoLocator: project.repoLocator,
								baseBranch: project.baseBranch,
								workBranch: project.workBranch,
								projectMetadata: project.metadata,
							},
						]
					: [];
			});
			return instanceId && snapshots.length === 0
				? { outcome: "project_not_found" }
				: { outcome: "ready", snapshots };
		},

		activateDeferredProcess(instanceId, prepared) {
			return run(ActivateDeferredProcess, { instanceId, prepared });
		},

		parkDeferredProcessActivationFailure(instanceId, failure) {
			return run(ParkDeferredProcessActivationFailure, { instanceId, failure });
		},

		startProcess(instanceId, startTurnId, opts) {
			return run(StartProcess, { instanceId, startTurnId, actor: opts?.actor });
		},

		abortProcess(instanceId, opts) {
			return run(AbortProcess, { instanceId, ...opts });
		},

		abortTurn(instanceId, opts) {
			return run(AbortTurn, {
				instanceId,
				reason: opts?.reason ?? "operator",
				...(opts?.actor ? { actor: opts.actor } : {}),
			});
		},

		retryProcess(instanceId, opts) {
			return run(RetryFailedTurn, { instanceId, ...(opts ?? {}) });
		},

		retryStartup(instanceId, startRecordId, opts) {
			return run(RetryStartup, { instanceId, startRecordId, ...(opts ?? {}) });
		},

		continueFailedTurn(instanceId, turnRecordId, options) {
			return run(ContinueFailedTurn, { instanceId, turnRecordId, options });
		},

		async parkProcessLifecycle(instanceId, payload) {
			const result = await run(ParkProcess, { instanceId, payload });
			return maybeBroadcastErrorAttentionToast(result);
		},

		async recordWorkerFailure(instanceId, payload) {
			const result = await run(WorkerFailure, { instanceId, payload });
			return maybeBroadcastErrorAttentionToast(result, { errorCode: payload.errorCode });
		},

		acceptWorkerTurnStart(instanceId, input) {
			return run(AcceptWorkerTurnStart, { instanceId, ...input });
		},

		async recordTurnOutcome(instanceId, payload, options) {
			return maybeBroadcastActionRequiredToast(
				await run(TurnOutcome, { instanceId, payload, onRecorded: options?.onRecorded }),
			);
		},

		recordTurnFailed(instanceId, payload, options) {
			return run(TurnFailed, { instanceId, payload, onRecorded: options?.onRecorded });
		},

		updateSemanticEntryRefs(instanceId, patch) {
			return run(UpdateSemanticRefs, { instanceId, patch });
		},

		updateProductRefs(instanceId, patch) {
			return run(UpdateProductRefs, { instanceId, patch });
		},

		queueInputs(instanceId, queued, opts) {
			return run(QueueInputs, { instanceId, queued, opts });
		},

		async dispatchExternalTurnTrigger(instanceId, actionId, input) {
			const result = await engine.executeProcessAction(instanceId, actionId, input, {
				source: "external",
			});
			if (
				!result.ok &&
				(result.code === "action_not_found" || result.code === "action_not_visible")
			) {
				return { ok: true, process: null, data: { ignored: true } };
			}
			return result;
		},

		async executeProcessAction(instanceId, actionId, input, opts) {
			const result = await run(ExecuteAction, { instanceId, actionId, input, opts });
			if (!result.ok) {
				if (result.stage === "post_commit" && result.process) {
					maybeBroadcastCommittedActionRequiredToast(
						deps,
						result.process,
						result.turnSelectionChange,
					);
					return buildActionPostCommitFailure(result.process, result.message, String(result.code));
				}
				return buildActionPreCommitFailure(result.message, String(result.code));
			}
			maybeBroadcastCommittedActionRequiredToast(deps, result.process, result.turnSelectionChange);
			return buildActionSuccess(result.process, result.data);
		},
	};

	return engine;
}
