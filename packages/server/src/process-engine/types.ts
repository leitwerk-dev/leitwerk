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
	ProcessActionExecutionOrigin,
	ProcessActionExecutionSource,
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

export interface ParkProcessLifecyclePayload {
	selectedTurnId?: string | null;
	reason?: string;
	errorClass?: WorkerErrorClass;
}

export interface ProcessEngineLogger {
	error(payload: Record<string, unknown>, message?: string): void;
}

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
	processOperations: ProcessOperationCoordinator;
	broadcaster: Broadcaster;
	config?: LeitwerkConfig;
	toastTtlMs?: number;
	getSupervisor: () => WorkerSupervisor | undefined;
	extensionHost?: ExtensionHost;
	processGraphs: ProcessGraphRegistry;
	sessionReader?: ProcessSessionReader;
	getProcessActionRegistry?: () => ProcessActionRegistry | undefined;
	getProcessUiRegistry?: () => ProcessUiRegistry | undefined;
	logger?: ProcessEngineLogger;
	/** Required by the server-owned engine; embedded callers adapt at construction. */
	processModelPolicy: ServerProcessModelPolicy;
	getModelAvailabilitySnapshot: () => ModelStatusCacheSnapshot;
	afterRecord?: (process: ProcessInstance) => void | Promise<void>;
	afterSuccessHooks?: Set<(instanceId: string) => void | Promise<void>>;
	prepareTurnStarts?: (
		process: ProcessInstance,
		writes: Writes,
		providerOptions?: Readonly<Record<string, string>>,
		availabilitySnapshot?: ModelStatusCacheSnapshot,
	) => Promise<{ ok: true } | { ok: false; code: string; message: string }>;
}

export interface DecideContext {
	deps: ProcessEngineDeps;
	instanceId: string;
	process: ProcessInstance;
}

export interface ProcessTurnSelectionChange {
	fromTurnId: string | null;
	toTurnId: string | null;
	fromLifecycleStatus: ProcessLifecycleStatus;
	toLifecycleStatus: ProcessLifecycleStatus;
}

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

export type EngineFailureStage = "pre_commit" | "post_commit";

export interface EngineSuccess<T> {
	ok: true;
	process: ProcessInstance;
	data: T;
	turnSelectionChange?: ProcessTurnSelectionChange;
}

export interface EngineFailure<T> {
	ok: false;
	code: EngineErrorCode;
	message: string;
	process?: ProcessInstance | null;
	data?: T;
	turnSelectionChange?: ProcessTurnSelectionChange;
	stage?: EngineFailureStage;
}

export type EngineResult<T = undefined> = EngineSuccess<T> | EngineFailure<T>;

export type ActionExecutionFailureStage = ActionExecutionFailureStageLike;
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

export interface ProcessEngine {
	getDeferredProcessActivationSnapshots(
		query: DeferredProcessActivationSnapshotQuery,
	): DeferredProcessActivationSnapshotResult;
	activateDeferredProcess(
		instanceId: string,
		prepared: PreparedDeferredProcessActivation,
	): Promise<EngineResult<{ outcome: DeferredProcessActivationOutcome }>>;
	parkDeferredProcessActivationFailure(
		instanceId: string,
		failure: DeferredProcessActivationFailure,
	): Promise<
		EngineResult<{ outcome: "parked" | "stale" | "not_applicable" | "project_not_found" }>
	>;
	run<TOp extends OperationSpec<string, OperationInputBase, unknown>>(
		operation: TOp,
		input: OperationInput<TOp>,
	): Promise<EngineResult<OperationData<TOp>>>;

	startProcess(
		instanceId: string,
		startTurnId: TurnId,
		opts?: { actor?: Actor },
	): Promise<EngineResult<void>>;
	abortProcess(instanceId: string, opts?: { actor?: Actor }): Promise<EngineResult<void>>;
	abortTurn(
		instanceId: string,
		opts?: { reason?: string; actor?: Actor },
	): Promise<EngineResult<void>>;
	retryProcess(
		instanceId: string,
		opts?: {
			nextTurnModelProfileId?: string | null;
			providerOptions?: Readonly<Record<string, string>>;
			actor?: Actor;
		},
	): Promise<EngineResult<void>>;
	retryStartup(
		instanceId: string,
		startRecordId: string,
		opts?: {
			nextTurnModelProfileId?: string | null;
			providerOptions?: Readonly<Record<string, string>>;
		},
	): Promise<EngineResult<{ startRecordId: string }>>;
	continueFailedTurn(
		instanceId: string,
		turnRecordId: string,
		options?: {
			prompt?: string | null;
			nextTurnModelProfileId?: string | null;
			providerOptions?: Readonly<Record<string, string>>;
			actor?: Actor;
		},
	): Promise<EngineResult<void>>;
	parkProcessLifecycle(
		instanceId: string,
		payload: ParkProcessLifecyclePayload,
	): Promise<EngineResult<void>>;
	recordWorkerFailure(
		instanceId: string,
		payload: {
			errorCode: string;
			message: string;
			errorClass?: WorkerErrorClass;
			workerLeaseId?: string | null;
			resultPiEntryId?: string | null;
			recoveryContext?: TurnFailedPayload["recoveryContext"];
		},
	): Promise<EngineResult<void>>;
	acceptWorkerTurnStart(
		instanceId: string,
		input: { startRecordId: string; proposedTurnRecordId: string; workerLeaseId: string },
	): Promise<EngineResult<{ turnRecordId: string }>>;
	recordTurnOutcome(
		instanceId: string,
		payload: TurnOutcomePayload,
		options?: { onRecorded?: () => void },
	): Promise<EngineResult<void>>;
	recordTurnFailed(
		instanceId: string,
		payload: TurnFailedPayload,
		options?: { onRecorded?: () => void },
	): Promise<EngineResult<void>>;
	updateSemanticEntryRefs(
		instanceId: string,
		patch: ProcessSemanticEntryRefPatch,
	): Promise<EngineResult<void>>;
	updateProductRefs(instanceId: string, patch: ProcessProductRefPatch): Promise<EngineResult<void>>;
	queueInputs(
		instanceId: string,
		queued: QueuedProcessInput[],
		opts?: { dispatchErrorMessage?: string; actor?: Actor },
	): Promise<EngineResult<ProcessInput[]>>;
	drainServerAutomaticTurns(instanceId: string): Promise<void>;
	dispatchExternalTurnTrigger(
		instanceId: string,
		actionId: string,
		input: Record<string, unknown>,
	): Promise<ActionExecutionResult | { ok: true; process: null; data: { ignored: true } }>;
	executeProcessAction(
		instanceId: string,
		actionId: string,
		input: Record<string, unknown>,
		opts?: {
			nextTurnModelProfileId?: string | null;
			source?: ProcessActionExecutionSource;
			origin?: ProcessActionExecutionOrigin;
			scheduledExecutionId?: string;
			consumeScheduledExecutionOnSuccess?: boolean;
			actor?: Actor;
		},
	): Promise<ActionExecutionResult>;
}
