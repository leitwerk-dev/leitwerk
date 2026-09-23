import type {
	Actor,
	ProcessInput,
	ProcessInstance,
	ProcessLifecycleStatus,
	TurnFailedPayload,
	TurnId,
	TurnOutcomePayload,
	WorkerErrorClass,
} from "@leitwerk-dev/domain";
import type {
	ActionExecutionFailureStageLike,
	ActionExecutionResultLike,
	DeferredProcessActivationFailure,
	DeferredProcessActivationOutcome,
	DeferredProcessActivationSnapshotQuery,
	DeferredProcessActivationSnapshotResult,
	PreparedDeferredProcessActivation,
	ProcessActionServiceLike,
} from "@leitwerk-dev/process-sdk";
import type { LeitwerkConfig } from "../config/config-types.js";
import type { RepositoryBundle } from "../db/repositories.js";
import type { ExtensionHost } from "../extensions/extension-host.js";
import type { ModelStatusCacheSnapshot } from "../model-providers/model-status-cache.js";
import type { ProcessActionRegistry } from "../process-action-registry.js";
import type { ProcessGraphRegistry } from "../process-graph.js";
import type { QueuedProcessInput } from "../process-input-dispatch.js";
import type { ServerProcessModelPolicy } from "../process-model-policy/index.js";
import type { ProcessOperationCoordinator } from "../process-operation-coordinator.js";
import type { ProcessSessionReader } from "../process-session-store.js";
import type { ProcessUiRegistry } from "../process-ui-registry.js";
import type { ProcessProductRefPatch } from "../product-ref-state.js";
import type { ProcessSemanticEntryRefPatch } from "../semantic-entry-ref-state.js";
import type { WorkerSupervisor } from "../supervisor/worker-supervisor.js";
import type { Broadcaster } from "../ws/broadcast.js";
import type { Reaction } from "./decision.js";
import type {
	OperationData,
	OperationInput,
	OperationInputBase,
	OperationSpec,
} from "./operation.js";
import type { Writes } from "./writes/writes.js";

/** @internal */
export interface ParkProcessLifecyclePayload {
	/** @internal */
	selectedTurnId?: string | null;
	/** @internal */
	reason?: string;
	/** @internal */
	errorClass?: WorkerErrorClass;
}

/** @internal */
export interface ProcessEngineLogger {
	/** @internal */
	error(payload: Record<string, unknown>, message?: string): void;
}

/** @internal */
export interface ProcessEngineDeps
	extends Pick<
		RepositoryBundle,
		| "processes"
		| "events"
		| "futureExecutions"
		| "inputs"
		| "projects"
		| "pendingExternalSourceFires"
		| "leafOutcomeSnapshots"
		| "questionRequests"
		| "turnRecords"
		| "turnStarts"
		| "leases"
		| "turnAnnotations"
		| "transaction"
	> {
	/** Required for processes that declare mapped LLM turns. @internal */
	mappedRuns?: RepositoryBundle["mappedRuns"];
	/** @internal */
	processOperations: ProcessOperationCoordinator;
	/** @internal */
	broadcaster: Broadcaster;
	/** @internal */
	config?: LeitwerkConfig;
	/** @internal */
	toastTtlMs?: number;
	/** @internal */
	getSupervisor: () => WorkerSupervisor | undefined;
	/** @internal */
	extensionHost?: ExtensionHost;
	/** @internal */
	processGraphs: ProcessGraphRegistry;
	/** @internal */
	sessionReader?: ProcessSessionReader;
	/** @internal */
	getProcessActionRegistry?: () => ProcessActionRegistry | undefined;
	/** @internal */
	getProcessUiRegistry?: () => ProcessUiRegistry | undefined;
	/** @internal */
	logger?: ProcessEngineLogger;
	/** Required by the server-owned engine; embedded callers adapt at construction. @internal */
	processModelPolicy: ServerProcessModelPolicy;
	/** @internal */
	getModelAvailabilitySnapshot: () => ModelStatusCacheSnapshot;
	/** @internal */
	afterRecord?: (process: ProcessInstance) => void | Promise<void>;
	/** @internal */
	afterSuccessHooks?: Set<(instanceId: string) => void | Promise<void>>;
	/** @internal */
	isNewTurnBlocked?: (instanceId: string) => boolean;
	/** @internal */
	prepareTurnStarts?: (
		process: ProcessInstance,
		writes: Writes,
		providerOptions?: Readonly<Record<string, string>>,
		availabilitySnapshot?: ModelStatusCacheSnapshot,
	) => Promise<
		| {
				/** @internal */
				ok: true;
		  }
		| {
				/** @internal */
				ok: false;
				/** @internal */
				code: string;
				/** @internal */
				message: string;
		  }
	>;
}

/** @internal */
export interface DecideContext {
	/** @internal */
	deps: ProcessEngineDeps;
	/** @internal */
	instanceId: string;
	/** @internal */
	process: ProcessInstance;
}

/** @internal */
export interface ProcessTurnSelectionChange {
	/** @internal */
	fromTurnId: string | null;
	/** @internal */
	toTurnId: string | null;
	/** @internal */
	fromLifecycleStatus: ProcessLifecycleStatus;
	/** @internal */
	toLifecycleStatus: ProcessLifecycleStatus;
}

/** @internal */
export type EngineErrorCode =
	| "process_not_found"
	| "operation_failed"
	| "record_failed"
	| "post_commit_failed"
	| "approval_conflict"
	| "external_publish_failed"
	| "input_dispatch_failed"
	| "worker_reconcile_failed"
	| "retry_target_missing"
	| (string & {});

/** @internal */
export type EngineFailureStage = "pre_commit" | "post_commit";

/** @internal */
export interface EngineSuccess<T> {
	/** @internal */
	ok: true;
	/** @internal */
	process: ProcessInstance;
	/** @internal */
	data: T;
	/** @internal */
	turnSelectionChange?: ProcessTurnSelectionChange;
}

/** @internal */
export interface EngineFailure<T> {
	/** @internal */
	ok: false;
	/** @internal */
	code: EngineErrorCode;
	/** @internal */
	message: string;
	/** @internal */
	process?: ProcessInstance | null;
	/** @internal */
	data?: T;
	/** @internal */
	turnSelectionChange?: ProcessTurnSelectionChange;
	/** @internal */
	stage?: EngineFailureStage;
}

/** @internal */
export type EngineResult<T = undefined> = EngineSuccess<T> | EngineFailure<T>;

export type ActionExecutionFailureStage = ActionExecutionFailureStageLike;
/** @internal */
export type ActionExecutionResult = ActionExecutionResultLike;

export interface RecordedDecision<
	TOp extends OperationSpec<string, OperationInputBase, unknown> = OperationSpec<
		string,
		OperationInputBase,
		unknown
	>,
> {
	operation: TOp;
	operationKind: TOp["kind"];
	input: OperationInput<TOp>;
	process: ProcessInstance;
	data: OperationData<TOp>;
	turnSelectionChange?: ProcessTurnSelectionChange;
	reactions: Reaction[];
}

export type RecordResult<TOp extends OperationSpec<string, OperationInputBase, unknown>> =
	| { ok: true; recorded: RecordedDecision<TOp> }
	| {
			ok: false;
			stage: "pre_commit";
			code: EngineErrorCode;
			message: string;
	  }
	| {
			ok: false;
			stage: "post_commit";
			code: EngineErrorCode;
			message: string;
			recorded: RecordedDecision<TOp>;
	  };

/** @internal */
export interface ProcessEngine {
	/** @internal */
	getDeferredProcessActivationSnapshots(
		query: DeferredProcessActivationSnapshotQuery,
	): DeferredProcessActivationSnapshotResult;
	/** @internal */
	activateDeferredProcess(
		instanceId: string,
		prepared: PreparedDeferredProcessActivation,
	): Promise<
		EngineResult<{
			/** @internal */
			outcome: DeferredProcessActivationOutcome;
		}>
	>;
	/** @internal */
	parkDeferredProcessActivationFailure(
		instanceId: string,
		failure: DeferredProcessActivationFailure,
	): Promise<
		EngineResult<{
			/** @internal */
			outcome: "parked" | "stale" | "not_applicable" | "project_not_found";
		}>
	>;
	/** @internal */
	run<TOp extends OperationSpec<string, OperationInputBase, unknown>>(
		operation: TOp,
		input: OperationInput<TOp>,
	): Promise<EngineResult<OperationData<TOp>>>;

	/** @internal */
	startProcess(
		instanceId: string,
		startTurnId: TurnId,
		opts?: {
			/** @internal */
			actor?: Actor;
		},
	): Promise<EngineResult<void>>;
	/** @internal */
	abortProcess(
		instanceId: string,
		opts?: {
			/** @internal */
			actor?: Actor;
			/** @internal */
			expectedTurnRecordId?: string;
		},
	): Promise<EngineResult<void>>;
	/** @internal */
	abortTurn(
		instanceId: string,
		opts?: {
			/** @internal */
			reason?: string;
			/** @internal */
			actor?: Actor;
		},
	): Promise<EngineResult<void>>;
	/** @internal */
	retryProcess(
		instanceId: string,
		opts?: {
			/** @internal */
			nextTurnModelProfileId?: string | null;
			/** @internal */
			providerOptions?: Readonly<Record<string, string>>;
			/** @internal */
			actor?: Actor;
		},
	): Promise<EngineResult<void>>;
	/** @internal */
	retryStartup(
		instanceId: string,
		startRecordId: string,
		opts?: {
			/** @internal */
			nextTurnModelProfileId?: string | null;
			/** @internal */
			providerOptions?: Readonly<Record<string, string>>;
		},
	): Promise<
		EngineResult<{
			/** @internal */
			startRecordId: string;
		}>
	>;
	/** @internal */
	continueFailedTurn(
		instanceId: string,
		turnRecordId: string,
		options?: {
			/** @internal */
			prompt?: string | null;
			/** @internal */
			nextTurnModelProfileId?: string | null;
			/** @internal */
			providerOptions?: Readonly<Record<string, string>>;
			/** @internal */
			actor?: Actor;
		},
	): Promise<EngineResult<void>>;
	/** @internal */
	parkProcessLifecycle(
		instanceId: string,
		payload: ParkProcessLifecyclePayload,
	): Promise<EngineResult<void>>;
	/** @internal */
	recordWorkerFailure(
		instanceId: string,
		payload: {
			/** @internal */
			errorCode: string;
			/** @internal */
			message: string;
			/** @internal */
			errorClass?: WorkerErrorClass;
			/** @internal */
			workerLeaseId?: string | null;
			/** @internal */
			resultPiEntryId?: string | null;
			/** @internal */
			recoveryContext?: TurnFailedPayload["recoveryContext"];
		},
	): Promise<EngineResult<void>>;
	/** @internal */
	acceptWorkerTurnStart(
		instanceId: string,
		input: {
			/** @internal */
			startRecordId: string;
			/** @internal */
			proposedTurnRecordId: string;
			/** @internal */
			workerLeaseId: string;
		},
	): Promise<
		EngineResult<{
			/** @internal */
			turnRecordId: string;
		}>
	>;
	/** @internal */
	recordTurnOutcome(
		instanceId: string,
		payload: TurnOutcomePayload,
		options?: {
			/** @internal */
			onRecorded?: () => void;
		},
	): Promise<EngineResult<void>>;
	/** @internal */
	recordTurnFailed(
		instanceId: string,
		payload: TurnFailedPayload,
		options?: {
			/** @internal */
			onRecorded?: () => void;
		},
	): Promise<EngineResult<void>>;
	/** @internal */
	updateSemanticEntryRefs(
		instanceId: string,
		patch: ProcessSemanticEntryRefPatch,
	): Promise<EngineResult<void>>;
	/** @internal */
	updateProductRefs(instanceId: string, patch: ProcessProductRefPatch): Promise<EngineResult<void>>;
	/** @internal */
	queueInputs(
		instanceId: string,
		queued: QueuedProcessInput[],
		opts?: {
			/** @internal */
			dispatchErrorMessage?: string;
			/** @internal */
			actor?: Actor;
		},
	): Promise<EngineResult<ProcessInput[]>>;
	/** @internal */
	dispatchExternalTurnTrigger(
		instanceId: string,
		actionId: string,
		input: Record<string, unknown>,
	): Promise<
		| ActionExecutionResult
		| {
				/** @internal */
				ok: true;
				/** @internal */
				process: null;
				/** @internal */
				data: {
					/** @internal */
					ignored: true;
				};
		  }
	>;
	/** @internal */
	executeProcessAction(
		instanceId: string,
		actionId: string,
		input: Record<string, unknown>,
		opts?: NonNullable<Parameters<ProcessActionServiceLike["executeAction"]>[3]> & {
			/** @internal */
			scheduledExecutionId?: string;
			/** @internal */
			consumeScheduledExecutionOnSuccess?: boolean;
		},
	): Promise<ActionExecutionResult>;
}
