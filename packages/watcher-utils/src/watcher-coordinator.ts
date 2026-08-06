import type { ProcessInstance, TurnId } from "@leitwerk-dev/domain";
import {
	type ExternalWriteLogRepoLike,
	recordWriteIfMissing,
	type WriteIdentity,
} from "@leitwerk-dev/external-writes";
import type { KnownDurableWsFrameType, WsPayloadByType } from "@leitwerk-dev/protocol";
import type { PollResult } from "./poll-loop.js";
import {
	ensureWorkerForActiveAgent,
	hasProcessEvent,
	type ProcessEventRepoLike,
	processNeedsWorker,
	type WorkerSupervisorLike,
} from "./process-helpers.js";

export interface AgentRepoAccessorLike {
	getById(id: string): ProcessInstance | null;
}

export interface BroadcasterLike {
	sendDurable<T extends KnownDurableWsFrameType>(
		type: T,
		payload: WsPayloadByType[T],
		instanceId?: string,
	): void;
}

export interface WatcherCommandResult {
	ok: boolean;
	code?: string;
	message?: string;
	process?: ProcessInstance | null;
}

export interface WatcherCommandServiceLike {
	startProcess(instanceId: string, startTurnId: TurnId): Promise<WatcherCommandResult>;
	abortProcess(instanceId: string): Promise<WatcherCommandResult>;
}

export interface WatcherStartupDeps {
	processes: AgentRepoAccessorLike;
	events: ProcessEventRepoLike;
	broadcaster: BroadcasterLike;
	commands: WatcherCommandServiceLike;
	supervisor: WorkerSupervisorLike;
}

export interface ContinueWatcherAgentStartupOptions {
	process: ProcessInstance;
	startTurnId: TurnId;
	createdEventData: Record<string, unknown>;
	createdBroadcastData: Record<string, unknown>;
	/** Defaults to true. Set false when the shared launch executor already emitted process.created. */
	broadcastCreated?: boolean;
	afterCreatedEvent?: (process: ProcessInstance) => Promise<void> | void;
	beforeStart?: (process: ProcessInstance) => Promise<void>;
}

export function requireWatcherStartTurnId(
	launchPlan: { launcherId: string; startTurnId: TurnId | null },
	targetLabel: string,
): TurnId {
	if (launchPlan.startTurnId) {
		return launchPlan.startTurnId;
	}
	throw new Error(
		`Watcher launcher '${launchPlan.launcherId}' did not declare a startTurnId for ${targetLabel}`,
	);
}

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

export type DiscoveryResumeResult = "handled" | "skipped" | undefined;

export type DiscoveryCreateResult =
	| { outcome: "created"; instanceId: string }
	| { outcome: "skipped" }
	| { outcome: "handled" }
	| null
	| undefined;

export interface DiscoveryPassOptions<TItem> {
	items: readonly TItem[];
	result: PollResult;
	findExistingAgent(item: TItem): ProcessInstance | null;
	getResultLabel(item: TItem): string;
	resumeDiscoveredAgent(process: ProcessInstance, item: TItem): Promise<DiscoveryResumeResult>;
	createAgent(item: TItem): Promise<DiscoveryCreateResult>;
	ensureWorkerForExistingAgent?(process: ProcessInstance, item: TItem): Promise<boolean>;
	formatError(item: TItem, error: unknown): string;
}

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

export interface AbortReconciliationOptions {
	candidates: readonly ProcessInstance[];
	result: PollResult;
	events: ProcessEventRepoLike;
	commands: WatcherCommandServiceLike;
	shouldAbort(process: ProcessInstance): Promise<boolean>;
	getResultLabel(process: ProcessInstance): string;
	getErrorLabel(process: ProcessInstance): string;
	getAbortedEventData(process: ProcessInstance): Record<string, unknown>;
}

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

export interface CompletionReconciliationResult {
	changed: boolean;
	writeIdentity?: WriteIdentity;
	metadata?: Record<string, unknown>;
}

export interface CompletionReconciliationOptions {
	candidates: readonly ProcessInstance[];
	result: PollResult;
	externalWrites: ExternalWriteLogRepoLike;
	reconcile(process: ProcessInstance): Promise<CompletionReconciliationResult>;
	getResultLabel(process: ProcessInstance): string;
	getErrorLabel(process: ProcessInstance): string;
}

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

export function shouldEnsureWorkerForExistingActiveAgent(
	deps: { supervisor: WorkerSupervisorLike },
	process: ProcessInstance,
): boolean {
	return processNeedsWorker(process) && !deps.supervisor.getWorker(process.id);
}

export function deferWatcherLaunchStart<TLaunchPlan extends { startTurnId: unknown }>(
	launchPlan: TLaunchPlan,
): TLaunchPlan {
	return launchPlan.startTurnId === null ? launchPlan : { ...launchPlan, startTurnId: null };
}

export function launchFailureMessage(result: {
	status: number;
	body: Record<string, unknown>;
}): string {
	return typeof result.body.error === "string" && result.body.error.trim().length > 0
		? result.body.error
		: `Process launch failed with status ${result.status}`;
}
