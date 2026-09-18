import type { ProcessInstance, TurnId } from "@leitwerk-dev/domain";
import type { WriteIdentity } from "@leitwerk-dev/external-writes";
import {
	type ExternalWriteLogRepoLike,
	recordWriteIfMissing,
} from "@leitwerk-dev/external-writes/internal";
import type { KnownDurableWsFrameType, WsPayloadByType } from "@leitwerk-dev/protocol";
import type { PollResult } from "./poll-loop.js";
import {
	ensureWorkerForActiveAgent,
	hasProcessEvent,
	type ProcessEventRepoLike,
	processNeedsWorker,
	type WorkerSupervisorLike,
} from "./process-helpers.js";

/** @internal */
export interface AgentRepoAccessorLike {
	/** @internal */
	getById(id: string): ProcessInstance | null;
}

/** @internal */
export interface BroadcasterLike {
	/** @internal */
	sendDurable<T extends KnownDurableWsFrameType>(
		type: T,
		payload: WsPayloadByType[T],
		instanceId?: string,
	): void;
}

/** @internal */
export interface WatcherCommandResult {
	/** @internal */
	ok: boolean;
	/** @internal */
	code?: string;
	/** @internal */
	message?: string;
	/** @internal */
	process?: ProcessInstance | null;
}

/** @internal */
export interface WatcherCommandServiceLike {
	/** @internal */
	startProcess(instanceId: string, startTurnId: TurnId): Promise<WatcherCommandResult>;
	/** @internal */
	abortProcess(instanceId: string): Promise<WatcherCommandResult>;
}

/** @internal */
export interface WatcherStartupDeps {
	/** @internal */
	processes: AgentRepoAccessorLike;
	/** @internal */
	events: ProcessEventRepoLike;
	/** @internal */
	broadcaster: BroadcasterLike;
	/** @internal */
	commands: WatcherCommandServiceLike;
	/** @internal */
	supervisor: WorkerSupervisorLike;
}

/** @internal */
export interface ContinueWatcherAgentStartupOptions {
	/** @internal */
	process: ProcessInstance;
	/** @internal */
	startTurnId: TurnId;
	/** @internal */
	createdEventData: Record<string, unknown>;
	/** @internal */
	createdBroadcastData: Record<string, unknown>;
	/** Defaults to true. Set false when the shared launch executor already emitted process.created. @internal */
	broadcastCreated?: boolean;
	/** @internal */
	afterCreatedEvent?: (process: ProcessInstance) => Promise<void> | void;
	/** @internal */
	beforeStart?: (process: ProcessInstance) => Promise<void>;
}

/** @internal */
export function requireWatcherStartTurnId(
	launchPlan: {
		/** @internal */
		launcherId: string;
		/** @internal */
		startTurnId: TurnId | null;
	},
	targetLabel: string,
): TurnId {
	if (launchPlan.startTurnId) {
		return launchPlan.startTurnId;
	}
	throw new Error(
		`Watcher launcher '${launchPlan.launcherId}' did not declare a startTurnId for ${targetLabel}`,
	);
}

/** @internal */
export async function continueWatcherAgentStartup(
	deps: WatcherStartupDeps,
	opts: ContinueWatcherAgentStartupOptions,
): Promise<string> {
	const { process } = opts;

	if (!hasProcessEvent(deps.events, process.id, "agent_created")) {
		deps.events.create({
			instanceId: process.id,
			eventType: "agent_created",
			data: opts.createdEventData,
		});
	}

	await opts.afterCreatedEvent?.(process);
	await opts.beforeStart?.(process);

	let currentProcess = deps.processes.getById(process.id) ?? process;
	if (currentProcess.lifecycleStatus === "discovered") {
		const startResult = await deps.commands.startProcess(currentProcess.id, opts.startTurnId);
		if (!startResult.ok) {
			currentProcess = startResult.process ?? currentProcess;
			throw new Error(startResult.message ?? "Failed to start process");
		}
		currentProcess = startResult.process ?? currentProcess;
		if (opts.broadcastCreated !== false) {
			deps.broadcaster.sendDurable(
				"process.created",
				{
					process: currentProcess,
					processId: currentProcess.processId,
					...opts.createdBroadcastData,
				},
				currentProcess.id,
			);
		}
	}

	await ensureWorkerForActiveAgent(deps, currentProcess);
	return currentProcess.id;
}

/** @internal */
export type DiscoveryResumeResult = "handled" | "skipped" | undefined;

/** @internal */
export type DiscoveryCreateResult =
	| {
			/** @internal */
			outcome: "created";
			/** @internal */
			instanceId: string;
	  }
	| {
			/** @internal */
			outcome: "skipped";
	  }
	| {
			/** @internal */
			outcome: "handled";
	  }
	| null
	| undefined;

/** @internal */
export interface DiscoveryPassOptions<TItem> {
	/** @internal */
	items: readonly TItem[];
	/** @internal */
	result: PollResult;
	/** @internal */
	findExistingAgent(item: TItem): ProcessInstance | null;
	/** @internal */
	getResultLabel(item: TItem): string;
	/** @internal */
	resumeDiscoveredAgent(process: ProcessInstance, item: TItem): Promise<DiscoveryResumeResult>;
	/** @internal */
	createAgent(item: TItem): Promise<DiscoveryCreateResult>;
	/** @internal */
	ensureWorkerForExistingAgent?(process: ProcessInstance, item: TItem): Promise<boolean>;
	/** @internal */
	formatError(item: TItem, error: unknown): string;
}

/** @internal */
export async function runWatcherDiscoveryPass<TItem>(
	opts: DiscoveryPassOptions<TItem>,
): Promise<void> {
	for (const item of opts.items) {
		try {
			const existingAgent = opts.findExistingAgent(item);
			if (existingAgent) {
				if (existingAgent.lifecycleStatus === "discovered") {
					const resumeResult = await opts.resumeDiscoveredAgent(existingAgent, item);
					if (resumeResult === "skipped") {
						opts.result.skipped.push(opts.getResultLabel(item));
					}
					continue;
				}
				if (opts.ensureWorkerForExistingAgent) {
					const handled = await opts.ensureWorkerForExistingAgent(existingAgent, item);
					if (handled) {
						continue;
					}
				}
				opts.result.skipped.push(opts.getResultLabel(item));
				continue;
			}

			const createResult = await opts.createAgent(item);
			if (createResult?.outcome === "created") {
				opts.result.created.push(opts.getResultLabel(item));
				continue;
			}
			if (createResult?.outcome === "skipped") {
				opts.result.skipped.push(opts.getResultLabel(item));
			}
		} catch (error) {
			opts.result.errors.push(opts.formatError(item, error));
		}
	}
}

/** @internal */
export interface AbortReconciliationOptions {
	/** @internal */
	candidates: readonly ProcessInstance[];
	/** @internal */
	result: PollResult;
	/** @internal */
	events: ProcessEventRepoLike;
	/** @internal */
	commands: WatcherCommandServiceLike;
	/** @internal */
	shouldAbort(process: ProcessInstance): Promise<boolean>;
	/** @internal */
	getResultLabel(process: ProcessInstance): string;
	/** @internal */
	getErrorLabel(process: ProcessInstance): string;
	/** @internal */
	getAbortedEventData(process: ProcessInstance): Record<string, unknown>;
}

/** @internal */
export async function runWatcherAbortReconciliation(
	opts: AbortReconciliationOptions,
): Promise<void> {
	for (const process of opts.candidates) {
		try {
			const shouldAbort = await opts.shouldAbort(process);
			if (!shouldAbort) {
				continue;
			}

			const abortResult = await opts.commands.abortProcess(process.id);
			if (!abortResult.ok) {
				if (abortResult.code === "worker_reconcile_failed") {
					throw new Error(abortResult.message ?? "Failed to abort process");
				}
				continue;
			}

			const abortedAgent = abortResult.process ?? process;
			if (!hasProcessEvent(opts.events, abortedAgent.id, "aborted_label_removed")) {
				opts.events.create({
					instanceId: abortedAgent.id,
					eventType: "aborted_label_removed",
					data: opts.getAbortedEventData(abortedAgent),
				});
			}
			opts.result.aborted.push(opts.getResultLabel(process));
		} catch (error) {
			opts.result.errors.push(
				`${opts.getErrorLabel(process)}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}

/** @internal */
export interface CompletionReconciliationResult {
	/** @internal */
	changed: boolean;
	/** @internal */
	writeIdentity?: WriteIdentity;
	/** @internal */
	metadata?: Record<string, unknown>;
}

/** @internal */
export interface CompletionReconciliationOptions {
	/** @internal */
	candidates: readonly ProcessInstance[];
	/** @internal */
	result: PollResult;
	/** @internal */
	externalWrites: ExternalWriteLogRepoLike;
	/** @internal */
	reconcile(process: ProcessInstance): Promise<CompletionReconciliationResult>;
	/** @internal */
	getResultLabel(process: ProcessInstance): string;
	/** @internal */
	getErrorLabel(process: ProcessInstance): string;
}

/** @internal */
export async function runWatcherCompletionReconciliation(
	opts: CompletionReconciliationOptions,
): Promise<void> {
	for (const process of opts.candidates) {
		try {
			const reconciliation = await opts.reconcile(process);
			if (!reconciliation.changed) {
				continue;
			}

			if (reconciliation.writeIdentity) {
				recordWriteIfMissing(
					opts.externalWrites,
					process.id,
					reconciliation.writeIdentity,
					reconciliation.metadata,
				);
			}
			opts.result.labelExchanged.push(opts.getResultLabel(process));
		} catch (error) {
			opts.result.errors.push(
				`${opts.getErrorLabel(process)}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}

/** @internal */
export function shouldEnsureWorkerForExistingActiveAgent(
	deps: {
		/** @internal */
		supervisor: WorkerSupervisorLike;
	},
	process: ProcessInstance,
): boolean {
	return processNeedsWorker(process) && !deps.supervisor.getWorker(process.id);
}

/** @internal */
export function deferWatcherLaunchStart<
	TLaunchPlan extends {
		/** @internal */
		startTurnId: unknown;
	},
>(launchPlan: TLaunchPlan): TLaunchPlan {
	return launchPlan.startTurnId === null ? launchPlan : { ...launchPlan, startTurnId: null };
}

/** @internal */
export function launchFailureMessage(result: {
	/** @internal */
	status: number;
	/** @internal */
	body: Record<string, unknown>;
}): string {
	return typeof result.body.error === "string" && result.body.error.trim().length > 0
		? result.body.error
		: `Process launch failed with status ${result.status}`;
}
