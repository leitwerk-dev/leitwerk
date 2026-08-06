import type { ProcessInstance } from "@leitwerk-dev/domain";
import type { PostCommitEffect } from "../effects/post-commit-effect.js";
import type { ModelStatusCacheSnapshot } from "../model-providers/model-status-cache.js";
import {
	commitWrites,
	deriveReactions,
	type RecordCommit,
	type RecordWritesDeps,
} from "../process-engine/writes/commit-writes.js";
import type { WorkerIntent, Writes } from "../process-engine/writes/writes.js";
import { applyProcessPatchField } from "../process-engine/writes/writes.js";
import { evaluateAtStableAvailabilityRevision } from "../process-model-policy/index.js";
import { presentProcessModelPolicyFailure } from "../process-model-policy-presenter.js";
import type { Decision, Reaction } from "./decision.js";
import { logProcessEngineError, publicInternalEngineFailureMessage } from "./internal-failures.js";
import type {
	OperationData,
	OperationInput,
	OperationInputBase,
	OperationSpec,
} from "./operation.js";
import type {
	EngineErrorCode,
	ProcessEngineDeps,
	ProcessTurnSelectionChange,
	RecordedDecision,
	RecordResult,
} from "./types.js";

function getRecordDeps(deps: ProcessEngineDeps): RecordWritesDeps {
	return {
		processes: deps.processes,
		projects: deps.projects,
		events: deps.events,
		inputs: deps.inputs,
		leafOutcomeSnapshots: deps.leafOutcomeSnapshots,
		turnRecords: deps.turnRecords,
		turnStarts: deps.turnStarts,
		turnAnnotations: deps.turnAnnotations,
		futureExecutions: deps.futureExecutions,
		pendingExternalSourceFires: deps.pendingExternalSourceFires,
		questionRequests: deps.questionRequests,
		transaction: deps.transaction,
	};
}

export function getTurnSelectionChange(
	initialProcess: ProcessInstance,
	currentProcess: ProcessInstance,
): ProcessTurnSelectionChange | undefined {
	if (
		initialProcess.selectedTurnId === currentProcess.selectedTurnId &&
		initialProcess.lifecycleStatus === currentProcess.lifecycleStatus
	) {
		return undefined;
	}
	return {
		fromTurnId: initialProcess.selectedTurnId,
		toTurnId: currentProcess.selectedTurnId,
		fromLifecycleStatus: initialProcess.lifecycleStatus,
		toLifecycleStatus: currentProcess.lifecycleStatus,
	};
}

function parkInvalidModelConfiguration(
	writes: Writes,
	start: Extract<Writes["turnStartWrites"][number], { kind: "create" }>,
	process: ProcessInstance,
	summary: string,
): void {
	const previousState = start.input.state;
	start.input.state = {
		kind: "preparation_failed",
		requestedModelProfileId: process.selectedTurnModelProfileId?.trim() || null,
		providerOptions:
			previousState.kind === "preparation_failed" ? { ...previousState.providerOptions } : {},
		code: "invalid_model_configuration",
		safeSummary: summary,
	};
	applyProcessPatchField(writes, process, "lifecycleStatus", "error");
	writes.workerIntent = { kind: "reconcile" };
}

function injectWorkerReconcileReaction(
	reactions: readonly PostCommitEffect[],
	reaction: PostCommitEffect,
): Reaction[] {
	const firstNonBroadcastIndex = reactions.findIndex((candidate) => candidate.kind !== "broadcast");
	if (firstNonBroadcastIndex === -1) {
		return [...reactions, reaction];
	}
	return [
		...reactions.slice(0, firstNonBroadcastIndex),
		reaction,
		...reactions.slice(firstNonBroadcastIndex),
	];
}

function shouldDeriveWorkerReconcile(
	turnSelectionChange: ProcessTurnSelectionChange | undefined,
	workerIntent: WorkerIntent | undefined,
): boolean {
	return !!turnSelectionChange && (!workerIntent || workerIntent.kind === "reconcile");
}

export function deriveRecordedReactions(input: {
	commit: RecordCommit;
	decision: Decision<unknown>;
	turnSelectionChange: ProcessTurnSelectionChange | undefined;
	processGraphs: ProcessEngineDeps["processGraphs"];
}): Reaction[] {
	const baseReactions = deriveReactions(input.commit, input.decision.writes, {
		processGraphs: input.processGraphs,
	});
	const processAfter = input.commit.processAfter;
	if (
		processAfter &&
		shouldDeriveWorkerReconcile(input.turnSelectionChange, input.decision.writes.workerIntent)
	) {
		return injectWorkerReconcileReaction(baseReactions, {
			kind: "worker_reconcile",
			instanceId: input.commit.instanceId,
			processId: processAfter.processId,
			change: input.turnSelectionChange as ProcessTurnSelectionChange,
		});
	}
	return baseReactions;
}

function buildRecordedDecision<
	TOp extends OperationSpec<string, OperationInputBase, unknown>,
>(input: {
	operation: TOp;
	operationInput: OperationInput<TOp>;
	process: ProcessInstance;
	data: OperationData<TOp>;
	turnSelectionChange?: ProcessTurnSelectionChange;
	reactions: Reaction[];
}): RecordedDecision<TOp> {
	return {
		operation: input.operation,
		operationKind: input.operation.kind,
		input: input.operationInput,
		process: input.process,
		data: input.data,
		...(input.turnSelectionChange ? { turnSelectionChange: input.turnSelectionChange } : {}),
		reactions: input.reactions,
	};
}

export async function record<TOp extends OperationSpec<string, OperationInputBase, unknown>>(
	deps: ProcessEngineDeps,
	operation: TOp,
	input: OperationInput<TOp>,
	initialProcess: ProcessInstance,
	decision: Decision<OperationData<TOp>>,
): Promise<RecordResult<TOp>> {
	/**
	 * Durable boundary invariant: record(...) is the only ProcessEngine stage that
	 * writes process-owned durable state. It resolves selected-turn model state,
	 * commits all writes in one SQLite transaction, then derives a complete
	 * reaction list for the post-commit stage.
	 */
	const baselineWrites = structuredClone(decision.writes);
	const runModelPreparation = async (availability: ModelStatusCacheSnapshot) => {
		const candidateProcess: ProcessInstance = {
			...initialProcess,
			...decision.writes.processPatch,
		};
		const createdStart = decision.writes.turnStartWrites.find(
			(write): write is Extract<typeof write, { kind: "create" }> =>
				write.kind === "create" && write.input.turnType === "llm",
		);
		const shouldResolveSelection =
			!!candidateProcess.selectedTurnId &&
			(!!createdStart ||
				candidateProcess.selectedTurnId !== initialProcess.selectedTurnId ||
				(candidateProcess.lifecycleStatus === "active" &&
					initialProcess.lifecycleStatus !== "active") ||
				Object.hasOwn(decision.metadata ?? {}, "nextTurnModelProfileId"));
		if (!candidateProcess.selectedTurnId) {
			applyProcessPatchField(decision.writes, initialProcess, "selectedTurnModelProfileId", null);
			applyProcessPatchField(decision.writes, initialProcess, "selectedTurnModelKind", null);
			applyProcessPatchField(decision.writes, initialProcess, "selectedTurnModelSource", null);
		} else if (shouldResolveSelection && candidateProcess.selectedTurnId) {
			const resolution = deps.processModelPolicy.evaluate({
				kind: "process_turn",
				process: candidateProcess,
				turnId: candidateProcess.selectedTurnId,
				availability,
				startKind: createdStart?.input.startKind,
				initialSelection:
					createdStart?.input.startKind === "selected_turn" &&
					initialProcess.selectedTurnId === null &&
					initialProcess.lifecycleStatus === "discovered" &&
					initialProcess.planRevision === 0,
				...(Object.hasOwn(decision.metadata ?? {}, "nextTurnModelProfileId")
					? { modelOverride: decision.metadata?.nextTurnModelProfileId ?? null }
					: {}),
			});
			if (
				!resolution.ok &&
				resolution.code !== "model_unavailable" &&
				resolution.code !== "model_stale" &&
				resolution.code !== "model_required"
			) {
				const message = presentProcessModelPolicyFailure(resolution);
				if (createdStart) {
					parkInvalidModelConfiguration(decision.writes, createdStart, candidateProcess, message);
					return { ok: true as const };
				}
				return {
					ok: false as const,
					code: resolution.code,
					message,
				};
			}
			const selection = resolution.selection;
			applyProcessPatchField(
				decision.writes,
				initialProcess,
				"selectedTurnModelProfileId",
				selection?.modelProfileId ?? null,
			);
			applyProcessPatchField(
				decision.writes,
				initialProcess,
				"selectedTurnModelKind",
				selection?.provenance.kind ?? null,
			);
			applyProcessPatchField(
				decision.writes,
				initialProcess,
				"selectedTurnModelSource",
				selection?.provenance.source ?? null,
			);
		}
		if (deps.prepareTurnStarts) {
			const preparation = await deps.prepareTurnStarts(
				initialProcess,
				decision.writes,
				decision.metadata?.providerOptions,
				availability,
			);
			if (!preparation.ok) return preparation;
		}
		return { ok: true as const };
	};
	const stablePreparation = await evaluateAtStableAvailabilityRevision({
		availability: deps.getModelAvailabilitySnapshot(),
		getModelAvailabilitySnapshot: deps.getModelAvailabilitySnapshot,
		evaluate: runModelPreparation,
		beforeRetry: () => {
			Object.assign(decision.writes, structuredClone(baselineWrites));
		},
	});
	if (!stablePreparation.ok) {
		return {
			ok: false,
			stage: "pre_commit",
			code: "stale_evaluation_snapshot",
			message: "Model availability changed repeatedly during start preparation",
		};
	}
	const preparation = stablePreparation.value;
	if (!preparation.ok) {
		return {
			ok: false,
			stage: "pre_commit",
			code: preparation.code,
			message: preparation.message,
		};
	}

	let commit: RecordCommit;
	try {
		commit = commitWrites(getRecordDeps(deps), input.instanceId, decision.writes);
	} catch (error) {
		logProcessEngineError(deps.logger, {
			err: error,
			operationKind: operation.kind,
			instanceId: input.instanceId,
			stage: "pre_commit",
			code: "record_failed",
		});
		return {
			ok: false,
			stage: "pre_commit",
			code: "record_failed",
			message: publicInternalEngineFailureMessage("record_failed", "pre_commit"),
		};
	}

	const process = commit.processAfter ?? deps.processes.getById(input.instanceId) ?? initialProcess;
	const turnSelectionChange = getTurnSelectionChange(initialProcess, process);
	try {
		const reactions = deriveRecordedReactions({
			commit,
			decision: decision as Decision<unknown>,
			turnSelectionChange,
			processGraphs: deps.processGraphs,
		});
		const data = decision.deriveData ? decision.deriveData(commit) : decision.data;
		return {
			ok: true,
			recorded: buildRecordedDecision({
				operation,
				operationInput: input,
				process,
				data,
				...(turnSelectionChange ? { turnSelectionChange } : {}),
				reactions,
			}),
		};
	} catch (error) {
		const code: EngineErrorCode = "post_commit_failed";
		logProcessEngineError(deps.logger, {
			err: error,
			operationKind: operation.kind,
			instanceId: input.instanceId,
			stage: "post_commit",
			code,
		});
		return {
			ok: false,
			stage: "post_commit",
			code,
			message: publicInternalEngineFailureMessage(code, "post_commit"),
			recorded: buildRecordedDecision({
				operation,
				operationInput: input,
				process,
				data: decision.data,
				...(turnSelectionChange ? { turnSelectionChange } : {}),
				reactions: [],
			}),
		};
	}
}
