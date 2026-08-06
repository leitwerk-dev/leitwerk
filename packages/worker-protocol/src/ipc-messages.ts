import type {
	CurrentExecutionRef,
	NormalizedQuestion,
	PreparedTurnStart,
	ProcessInputTarget,
	ProcessLifecycleStatus,
	ProcessSemanticEntryRefKey,
	ProcessTurnRecordPathType,
	ProcessTurnType,
	TurnFailedPayload,
	TurnStartRecord,
	WorkerBootstrapReceipt,
} from "@leitwerk-dev/domain";
import type { ConfigSnapshot } from "@leitwerk-dev/protocol/config-snapshot";
import { IPC_PROTOCOL_VERSION, type IpcEnvelope } from "./ipc-codec.js";

export interface ProcessInstanceSnapshot {
	id?: string;
	processId?: string;
	selectedTurnId?: string | null;
	lifecycleStatus?: ProcessLifecycleStatus;
	currentExecution?: CurrentExecutionRef;
	planRevision?: number;
	title?: string | null;
	externalId?: string | null;
	externalUrl?: string | null;
	metadata?: Record<string, unknown> | null;
	defaultModelProfileId?: string | null;
	turnConfigsJson?: string | null;
	selectedTurnModelProfileId?: string | null;
	paramsJson?: string | null;
	stateJson?: string | null;
	createdAt?: string;
	updatedAt?: string;
}

export interface ProcessProjectSnapshot {
	id?: string;
	instanceId?: string;
	key: string;
	repoLocator: string;
	repoLocatorKind?: "remote_url" | "local_path";
	baseBranch: string;
	workBranch?: string | null;
	externalId?: string | null;
	externalUrl?: string | null;
	metadata?: Record<string, unknown> | null;
	pipelineStatus?: string | null;
	createdAt?: string;
	updatedAt?: string;
}

export interface InputDelivery {
	inputId: string;
	sequence: number;
	source: string;
	kind: string;
	target: ProcessInputTarget | null;
	receivedAt: string;
	bodyMarkdown: string;
}

export interface WorkerRuntimeContextSnapshot {
	processSnapshot: ProcessInstanceSnapshot;
	projectSnapshots: ProcessProjectSnapshot[];
	turnResultMarkdownBySemanticRef?: Partial<Record<ProcessSemanticEntryRefKey, string>>;
	turnResultMarkdownByProduct?: Record<string, string>;
}

export interface WorkerCredentialMaterial {
	providerId: string;
	revision: number;
	/** Secret payload. This type is valid only in worker.start and credential-update frames. */
	values: Record<string, string>;
}

export interface WorkerGitSshCredential {
	projectKey: string;
	kind: "git_ssh";
	credentialRef: string;
	/** Secret values; valid only while preparing worker.start. */
	privateKey: string;
	knownHosts: string;
}

export interface LlmWorkerStartBootstrap {
	kind: "llm";
	resourceBundle: { digest: string; archiveBase64: string };
	credential: WorkerCredentialMaterial | null;
}

export interface AutomaticWorkerStartBootstrap {
	kind: "automatic";
}

interface WorkerStartPayloadBase extends WorkerRuntimeContextSnapshot {
	workerLeaseId: string;
	turnStart: TurnStartRecord;
	/**
	 * The immutable pre-acceptance tree plan from the lease that first accepted
	 * this start. It is supplied only when a replacement resumes a running turn.
	 */
	acceptedPreparedStart?: PreparedTurnStart | null;
	pendingInputs: InputDelivery[];
	treePaths: {
		primaryTreeFile: string;
		workspaceRoot: string;
	};
	resume: boolean;
	resumeLeafEntryId?: string | null;
	/** Fresh secret material resolved for this physical worker start only. */
	repositoryCredentials?: WorkerGitSshCredential[];
}

export type WorkerStartPayload =
	| (WorkerStartPayloadBase & {
			bootstrap: LlmWorkerStartBootstrap;
			configSnapshot: ConfigSnapshot;
	  })
	| (WorkerStartPayloadBase & { bootstrap: AutomaticWorkerStartBootstrap });

export interface InputBatchPayload {
	inputs: InputDelivery[];
}

export interface WorkerStopPayload {
	reason: string;
}

export interface WorkerAbortTurnPayload {
	reason: string;
}

export interface WorkerTurnStartAcceptedPayload {
	startRecordId: string;
	turnRecordId: string;
}

export interface WorkerQuestionResponsePayload {
	turnRecordId: string;
	toolCallId: string;
	answers: string[];
}

export interface WorkerQuestionRequestedPayload {
	turnRecordId: string;
	toolCallId: string;
	questions: NormalizedQuestion[];
}

export interface WorkerCredentialUpdateResultPayload {
	providerId: string;
	accepted: boolean;
	currentRevision: number | null;
	safeReason?: string;
}

export type ServerToWorkerMessage =
	| (Omit<IpcEnvelope, "type" | "payload"> & {
			type: "worker.start";
			payload: WorkerStartPayload;
	  })
	| (Omit<IpcEnvelope, "type" | "payload"> & {
			type: "worker.turn_start_accepted";
			payload: WorkerTurnStartAcceptedPayload;
	  })
	| (Omit<IpcEnvelope, "type" | "payload"> & {
			type: "worker.credential_update_accepted";
			payload: WorkerCredentialUpdateResultPayload;
	  })
	| (Omit<IpcEnvelope, "type" | "payload"> & {
			type: "worker.question_response";
			payload: WorkerQuestionResponsePayload;
	  })
	| (Omit<IpcEnvelope, "type" | "payload"> & {
			type: "input.batch";
			payload: InputBatchPayload;
	  })
	| (Omit<IpcEnvelope, "type" | "payload"> & {
			type: "worker.stop";
			payload: WorkerStopPayload;
	  })
	| (Omit<IpcEnvelope, "type" | "payload"> & {
			type: "worker.abort_turn";
			payload: WorkerAbortTurnPayload;
	  });

export interface WorkerHelloPayload {
	/** Package/runtime version for diagnostics. */
	version: string;
	/** Server-worker API compatibility version. Missing only on legacy/test workers. */
	apiVersion?: string;
	capabilities: string[];
}

export interface WorkerReadyPayload {
	receipt: WorkerBootstrapReceipt;
	resumed: boolean;
	primaryTreeFile: string;
	workspaceRoot: string;
	aggregatedAgentsSources: string[];
	loadedSkills: string[];
	loadedAgentsFiles: Array<{ path: string; sizeBytes: number }>;
	loadedSkillFiles: Array<{ name: string; path: string }>;
	rootEntryId?: string | null;
}

export interface WorkerHeartbeatPayload {
	/** Diagnostic worker-local runtime state; not the authoritative lease transition channel. */
	state: string;
	lastSequenceConsumed: number;
	currentTurnId?: string;
	currentSelectedTurnId?: string | null;
}

export interface WorkerStatePayload {
	/** Explicit server-visible runtime transition, e.g. idle -> busy or busy -> idle. */
	from: string;
	to: string;
	reason: string;
}

export interface WorkerInputConsumedPayload {
	inputId: string;
	sequence: number;
	deliveryMode: string;
	currentPrimaryPathLeafId?: string | null;
	rootEntryId?: string | null;
	targetSemanticRef?: ProcessSemanticEntryRefKey | null;
	targetProductName?: string | null;
	targetEntryId?: string | null;
}

export interface WorkerEventPayload {
	eventType: string;
	selectedTurnId?: string | null;
	/**
	 * Object-shaped event data emitted by trusted worker senders. Decode helpers
	 * do not deeply validate this field at runtime; they only narrow it at the
	 * protocol boundary after envelope + message-type validation.
	 */
	data: Record<string, unknown>;
}

export interface WorkerTurnStartedPayload {
	startRecordId: string;
	proposedTurnRecordId: string;
}

export interface WorkerCredentialUpdatePayload {
	providerId: string;
	expectedRevision: number;
	/** Secret payload. It must not be copied into receipts, events, or turn state. */
	values: Record<string, string>;
}

export interface WorkerTurnOutcomePayload {
	turnRecordId: string;
	turnId: string;
	turnType: ProcessTurnType;
	outcome: string;
	params: Record<string, unknown>;
	pathType?: ProcessTurnRecordPathType;
	forkPiEntryId?: string | null;
	resultPiEntryId?: string | null;
	turnResultMarkdown?: string | null;
	rootEntryId?: string | null;
}

export interface WorkerTurnFailedPayload
	extends Omit<TurnFailedPayload, "instanceId" | "errorClass"> {
	errorClass?: string;
}

export interface WorkerLifecycleParkedPayload {
	selectedTurnId: string | null;
	reason?: string;
	errorClass?: string;
}

export interface WorkerCleanupStartedPayload {
	reason: string;
}

export interface WorkerCleanupCompletedPayload {
	releasedLocks: string[];
	removedTransientPaths: string[];
}

export interface WorkerFailedPayload {
	state: string;
	errorCode: string;
	message: string;
	errorClass: string;
	selectedTurnId?: string | null;
	retryAttempt?: number;
}

export type WorkerToServerMessage =
	| (Omit<IpcEnvelope, "type" | "payload"> & {
			type: "worker.hello";
			payload: WorkerHelloPayload;
	  })
	| (Omit<IpcEnvelope, "type" | "payload"> & {
			type: "worker.credential_update";
			payload: WorkerCredentialUpdatePayload;
	  })
	| (Omit<IpcEnvelope, "type" | "payload"> & {
			type: "worker.ready";
			payload: WorkerReadyPayload;
	  })
	| (Omit<IpcEnvelope, "type" | "payload"> & {
			type: "worker.heartbeat";
			payload: WorkerHeartbeatPayload;
	  })
	| (Omit<IpcEnvelope, "type" | "payload"> & {
			type: "worker.state";
			payload: WorkerStatePayload;
	  })
	| (Omit<IpcEnvelope, "type" | "payload"> & {
			type: "worker.input_consumed";
			payload: WorkerInputConsumedPayload;
	  })
	| (Omit<IpcEnvelope, "type" | "payload"> & {
			type: "worker.event";
			payload: WorkerEventPayload;
	  })
	| (Omit<IpcEnvelope, "type" | "payload"> & {
			type: "worker.turn_started";
			payload: WorkerTurnStartedPayload;
	  })
	| (Omit<IpcEnvelope, "type" | "payload"> & {
			type: "worker.question_requested";
			payload: WorkerQuestionRequestedPayload;
	  })
	| (Omit<IpcEnvelope, "type" | "payload"> & {
			type: "worker.turn_outcome";
			payload: WorkerTurnOutcomePayload;
	  })
	| (Omit<IpcEnvelope, "type" | "payload"> & {
			type: "worker.turn_failed";
			payload: WorkerTurnFailedPayload;
	  })
	| (Omit<IpcEnvelope, "type" | "payload"> & {
			type: "worker.lifecycle_parked";
			payload: WorkerLifecycleParkedPayload;
	  })
	| (Omit<IpcEnvelope, "type" | "payload"> & {
			type: "worker.cleanup_started";
			payload: WorkerCleanupStartedPayload;
	  })
	| (Omit<IpcEnvelope, "type" | "payload"> & {
			type: "worker.cleanup_completed";
			payload: WorkerCleanupCompletedPayload;
	  })
	| (Omit<IpcEnvelope, "type" | "payload"> & {
			type: "worker.failed";
			payload: WorkerFailedPayload;
	  });

export type AnyIpcMessage = ServerToWorkerMessage | WorkerToServerMessage;
export type IpcMessageType = AnyIpcMessage["type"];
export type IpcMessageOfType<TType extends IpcMessageType> = Extract<
	AnyIpcMessage,
	{ type: TType }
>;

export function createIpcMessage<TMessage extends AnyIpcMessage>(
	args: Omit<TMessage, "protocol" | "sentAt"> & { sentAt?: string },
): TMessage {
	return {
		protocol: IPC_PROTOCOL_VERSION,
		messageId: args.messageId,
		correlationId: args.correlationId,
		type: args.type,
		instanceId: args.instanceId,
		workerId: args.workerId,
		sentAt: args.sentAt ?? new Date().toISOString(),
		payload: args.payload,
	} as TMessage;
}
