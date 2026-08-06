/** @deprecated Import external-write idempotency from `@leitwerk-dev/external-writes`. */
export {
	createWriteIdentity,
	type EnsureWriteResult,
	type ExternalWriteLogRecordInput,
	type ExternalWriteLogRepoLike,
	ensureWrite,
	recordWriteIfMissing,
	type WriteIdentity,
} from "@leitwerk-dev/external-writes";
export { parseDurationMs } from "./duration-parse.js";
export {
	createPollLoop,
	emptyPollResult,
	type PollLoop,
	type PollResult,
} from "./poll-loop.js";
export {
	ensureWorkerForActiveAgent,
	hasProcessEvent,
	type ProcessEventRepoLike,
	processNeedsWorker,
	type WorkerSupervisorLike,
} from "./process-helpers.js";
export {
	consumeTriggerFile,
	errorCode,
	readTriggerFile,
	type TriggerFileReadResult,
} from "./trigger-files.js";
export {
	type AgentRepoAccessorLike,
	type BroadcasterLike,
	type CompletionReconciliationOptions,
	type CompletionReconciliationResult,
	type ContinueWatcherAgentStartupOptions,
	continueWatcherAgentStartup,
	type DiscoveryPassOptions,
	deferWatcherLaunchStart,
	launchFailureMessage,
	requireWatcherStartTurnId,
	runWatcherAbortReconciliation,
	runWatcherCompletionReconciliation,
	runWatcherDiscoveryPass,
	shouldEnsureWorkerForExistingActiveAgent,
	type WatcherCommandResult,
	type WatcherCommandServiceLike,
	type WatcherStartupDeps,
} from "./watcher-coordinator.js";
