import { createDurableWsFrame } from "@leitwerk-dev/protocol";
import { broadcastFutureExecutionUpdated } from "../future-execution-broadcast.js";
import { logProcessEngineError } from "../process-engine/internal-failures.js";
import type {
	EngineFailureStage,
	ProcessEngineDeps,
	ProcessEngineLogger,
} from "../process-engine/types.js";
import { reconcileWorkerForProcessTurnSelection } from "../process-engine/worker-reconciliation.js";
import {
	type DeferredProcessExtensionEvent,
	emitDeferredExtensionEvent,
} from "../process-engine/writes/deferred-extension-events.js";
import type { WorkerIntent } from "../process-engine/writes/writes.js";
import type { ProcessGraphRegistry } from "../process-graph.js";
import { dispatchProcessInputs } from "../process-input-dispatch.js";
import type { ProcessTitleGenerator } from "../process-title-generator.js";
import type { WorkerSupervisor } from "../supervisor/worker-supervisor.js";
import type { Broadcaster } from "../ws/broadcast.js";
import type { PostCommitEffect } from "./post-commit-effect.js";

export type PostCommitEffectFailureCode =
	| "input_dispatch_failed"
	| "worker_reconcile_failed"
	| "broadcast_failed"
	| "extension_event_failed"
	| "queue_process_title_failed"
	| "queue_future_execution_title_failed";

export type PostCommitEffectResult =
	| { ok: true }
	| { ok: false; code: PostCommitEffectFailureCode; message: string };

export interface PostCommitEffectRunnerDeps extends Pick<ProcessEngineDeps, "extensionHost"> {
	broadcaster: Broadcaster;
	getSupervisor: () => WorkerSupervisor | undefined;
	processGraphs?: ProcessGraphRegistry;
	processTitles?: ProcessTitleGenerator;
}

export interface PostCommitEffectLogContext {
	logger?: ProcessEngineLogger;
	operationKind?: string;
	stage: EngineFailureStage;
}

const workerEffectTails = new WeakMap<WorkerSupervisor, Map<string, Promise<void>>>();

async function runWorkerEffectExclusive<T>(
	supervisor: WorkerSupervisor | undefined,
	instanceId: string,
	options: { preemptGracefulStop?: boolean },
	work: () => Promise<T>,
): Promise<T> {
	if (!supervisor) return work();
	let tails = workerEffectTails.get(supervisor);
	if (!tails) {
		tails = new Map();
		workerEffectTails.set(supervisor, tails);
	}
	const pending = tails.get(instanceId);
	const previous = pending ?? Promise.resolve();
	if (pending && options.preemptGracefulStop) {
		// A newer restart has already committed while an older transition is still
		// gracefully stopping the previous worker. Do not make the replacement wait
		// for the full shutdown grace period: the old worker can no longer perform
		// useful work for the durable selected turn.
		supervisor.getWorker(instanceId)?.kill("SIGKILL");
	}
	let release!: () => void;
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	tails.set(instanceId, current);
	await previous;
	try {
		return await work();
	} finally {
		release();
		if (tails.get(instanceId) === current) tails.delete(instanceId);
	}
}

function getEffectInstanceId(effect: PostCommitEffect): string | null {
	switch (effect.kind) {
		case "broadcast":
			return effect.frame.instanceId ?? null;
		case "future_execution_updated":
			return effect.futureExecution.instanceId;
		case "dispatch_inputs":
		case "worker":
		case "worker_reconcile":
			return effect.instanceId;
		case "extension_event":
			return effect.event.payload.instanceId;
		case "queue_process_title":
			return effect.processId;
		case "queue_future_execution_title":
			return null;
	}
}

function logPostCommitEffectError(
	error: unknown,
	effect: PostCommitEffect,
	logContext: PostCommitEffectLogContext | undefined,
	code: string,
): void {
	if (!logContext?.operationKind) {
		return;
	}
	const instanceId = getEffectInstanceId(effect);
	if (!instanceId) {
		return;
	}
	logProcessEngineError(logContext.logger, {
		err: error,
		operationKind: logContext.operationKind,
		instanceId,
		stage: logContext.stage,
		code,
	});
}

async function runBestEffortEffect(
	effect: PostCommitEffect,
	logContext: PostCommitEffectLogContext | undefined,
	code: PostCommitEffectFailureCode,
	work: () => void | Promise<void>,
): Promise<Error | null> {
	try {
		await work();
		return null;
	} catch (error) {
		logPostCommitEffectError(error, effect, logContext, code);
		return error instanceof Error ? error : new Error(String(error));
	}
}

async function runWorkerEffect(
	supervisor: WorkerSupervisor | undefined,
	instanceId: string,
	effect: WorkerIntent,
): Promise<boolean> {
	switch (effect.kind) {
		case "stop_with_reason":
			await supervisor?.stopWorker(instanceId, effect.reason);
			return false;
		case "abort_turn":
			// AbortTurn.decide already rejected missing supervisor/worker; these checks
			// only catch a decide->commit race. The durable turn_abort_requested event
			// is already persisted, so a throw here surfaces as worker_reconcile_failed.
			if (!supervisor) {
				throw new Error("worker supervisor not available");
			}
			if (!supervisor.getWorker(instanceId)) {
				throw new Error("no active worker available");
			}
			supervisor.abortTurn(instanceId, effect.reason);
			return false;
		case "start_if_needed":
			if (supervisor && !supervisor.getWorker(instanceId)) {
				await supervisor.spawnWorker(instanceId);
				return true;
			}
			return false;
		case "restart_worker":
			if (!supervisor) {
				throw new Error("worker supervisor not available");
			}
			if (supervisor.getWorker(instanceId)) {
				await supervisor.stopWorker(instanceId, "turn_changed:restart_worker");
			}
			await supervisor.spawnWorker(instanceId);
			return true;
		case "reconcile":
			return false;
	}
}

export async function runPostCommitEffectList(
	deps: PostCommitEffectRunnerDeps,
	effects: readonly PostCommitEffect[],
	messages: { dispatchErrorMessage?: string; reconcileErrorMessage?: string } = {},
	logContext?: PostCommitEffectLogContext,
	options: { reportBestEffortFailures?: boolean } = {},
): Promise<PostCommitEffectResult> {
	const startedWorkers = new Set<string>();
	let bestEffortFailure: Exclude<PostCommitEffectResult, { ok: true }> | null = null;
	const recordBestEffortFailure = (
		code: PostCommitEffectFailureCode,
		error: Error | null,
	): void => {
		if (options.reportBestEffortFailures && error && !bestEffortFailure) {
			bestEffortFailure = { ok: false, code, message: error.message };
		}
	};
	const runAndRecordBestEffort = async (
		effect: PostCommitEffect,
		code: PostCommitEffectFailureCode,
		run: () => void | Promise<void>,
	): Promise<void> => {
		recordBestEffortFailure(code, await runBestEffortEffect(effect, logContext, code, run));
	};
	for (const effect of effects) {
		switch (effect.kind) {
			case "broadcast":
				await runAndRecordBestEffort(effect, "broadcast_failed", () =>
					deps.broadcaster.broadcast(createDurableWsFrame(effect.frame)),
				);
				break;
			case "future_execution_updated":
				await runAndRecordBestEffort(effect, "broadcast_failed", () =>
					broadcastFutureExecutionUpdated(
						deps.broadcaster,
						effect.futureExecution,
						effect.operation,
					),
				);
				break;
			case "worker":
				try {
					const supervisor = deps.getSupervisor();
					const started = await runWorkerEffectExclusive(
						supervisor,
						effect.instanceId,
						{ preemptGracefulStop: effect.effect.kind === "restart_worker" },
						() => runWorkerEffect(supervisor, effect.instanceId, effect.effect),
					);
					if (started) {
						startedWorkers.add(effect.instanceId);
					}
				} catch (error) {
					logPostCommitEffectError(error, effect, logContext, "worker_reconcile_failed");
					return {
						ok: false,
						code: "worker_reconcile_failed",
						message:
							messages.reconcileErrorMessage ??
							"Failed to reconcile worker for selected-turn change",
					};
				}
				break;
			case "worker_reconcile":
				try {
					const supervisor = deps.getSupervisor();
					const result = await runWorkerEffectExclusive(supervisor, effect.instanceId, {}, () =>
						reconcileWorkerForProcessTurnSelection(
							supervisor,
							effect.instanceId,
							effect.processId,
							deps.processGraphs,
							effect.change,
						),
					);
					if (result.startedWorker) {
						startedWorkers.add(effect.instanceId);
					}
				} catch (error) {
					logPostCommitEffectError(error, effect, logContext, "worker_reconcile_failed");
					return {
						ok: false,
						code: "worker_reconcile_failed",
						message:
							messages.reconcileErrorMessage ??
							"Failed to reconcile worker for selected-turn change",
					};
				}
				break;
			case "dispatch_inputs":
				if (startedWorkers.has(effect.instanceId)) {
					break;
				}
				try {
					await dispatchProcessInputs(
						{
							supervisor: deps.getSupervisor(),
						},
						effect.instanceId,
						effect.inputs,
						{ spawnIfMissing: effect.spawnIfMissing },
					);
				} catch (error) {
					logPostCommitEffectError(error, effect, logContext, "input_dispatch_failed");
					return {
						ok: false,
						code: "input_dispatch_failed",
						message:
							messages.dispatchErrorMessage ?? "Failed to deliver queued inputs to the worker",
					};
				}
				break;
			case "extension_event":
				await runAndRecordBestEffort(effect, "extension_event_failed", () =>
					emitDeferredExtensionEvent(
						deps.extensionHost,
						effect.event as DeferredProcessExtensionEvent,
					),
				);
				break;
			case "queue_process_title":
				await runAndRecordBestEffort(effect, "queue_process_title_failed", () =>
					deps.processTitles?.queueProcessTitleGeneration({
						processId: effect.processId,
						launchPlan: effect.launchPlan,
						launchRunId: effect.launchRunId,
					}),
				);
				break;
			case "queue_future_execution_title":
				await runAndRecordBestEffort(effect, "queue_future_execution_title_failed", () =>
					deps.processTitles?.queueFutureExecutionTitleGeneration({
						futureExecutionId: effect.futureExecutionId,
						launchPlan: effect.launchPlan,
						...(effect.expectedPayloadJson !== undefined
							? { expectedPayloadJson: effect.expectedPayloadJson }
							: {}),
					}),
				);
				break;
		}
	}
	return bestEffortFailure ?? { ok: true };
}
