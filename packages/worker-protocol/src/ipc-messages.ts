import type {
	CurrentExecutionRef,
	NormalizedQuestion,
	PreparedTurnStart,
	ProcessInputTarget,
	ProcessLifecycleStatus,
	ProcessSemanticEntryRefKey,
	TurnFailedPayload,
	TurnOutcomePayload,
	TurnStartRecord,
	WorkerBootstrapReceipt,
} from "@leitwerk-dev/domain";
import type { ConfigSnapshot } from "@leitwerk-dev/protocol/config-snapshot";
import { IPC_PROTOCOL_VERSION, type IpcEnvelope } from "./ipc-codec.js";

/** @internal */
export interface ProcessInstanceSnapshot {
	/** @internal */
	id?: string;
	/** @internal */
	processId?: string;
	/** @internal */
	selectedTurnId?: string | null;
	/** @internal */
	lifecycleStatus?: ProcessLifecycleStatus;
	/** @internal */
	currentExecution?: CurrentExecutionRef;
	/** @internal */
	planRevision?: number;
	/** @internal */
	title?: string | null;
	/** @internal */
	externalId?: string | null;
	/** @internal */
	externalUrl?: string | null;
	/** @internal */
	metadata?: Record<string, unknown> | null;
	/** @internal */
	defaultModelProfileId?: string | null;
	/** @internal */
	turnConfigsJson?: string | null;
	/** @internal */
	selectedTurnModelProfileId?: string | null;
	/** @internal */
	paramsJson?: string | null;
	/** @internal */
	stateJson?: string | null;
	/** @internal */
	createdAt?: string;
	/** @internal */
	updatedAt?: string;
}

/** @internal */
export interface ProcessProjectSnapshot {
	/** @internal */
	id?: string;
	/** @internal */
	instanceId?: string;
	/** @internal */
	key: string;
	/** @internal */
	repoLocator: string;
	/** @internal */
	repoLocatorKind?: "remote_url" | "local_path";
	/** @internal */
	baseBranch: string;
	/** @internal */
	workBranch?: string | null;
	/** @internal */
	externalId?: string | null;
	/** @internal */
	externalUrl?: string | null;
	/** @internal */
	metadata?: Record<string, unknown> | null;
	/** @internal */
	pipelineStatus?: string | null;
	/** @internal */
	createdAt?: string;
	/** @internal */
	updatedAt?: string;
}

/** @internal */
export interface InputDelivery {
	/** @internal */
	inputId: string;
	/** @internal */
	sequence: number;
	/** @internal */
	source: string;
	/** @internal */
	kind: string;
	/** @internal */
	target: ProcessInputTarget | null;
	/** @internal */
	receivedAt: string;
	/** @internal */
	bodyMarkdown: string;
}

/** @internal */
export interface WorkerRuntimeContextSnapshot {
	/** @internal */
	processSnapshot: ProcessInstanceSnapshot;
	/** @internal */
	projectSnapshots: ProcessProjectSnapshot[];
	/** @internal */
	turnResultMarkdownBySemanticRef?: Partial<Record<ProcessSemanticEntryRefKey, string>>;
	/** @internal */
	turnResultMarkdownByProduct?: Record<string, string>;
}

/** @internal */
export interface WorkerCredentialMaterial {
	/** @internal */
	providerId: string;
	/** Null for generated credentials that are materialized but never synchronized. */
	/** @internal */
	revision: number | null;
	/** Secret payload. This type is valid only in worker.start and credential-update frames. */
	/** @internal */
	values: Record<string, string>;
}

/** @internal */
export interface WorkerGitSshCredential {
	/** @internal */
	projectKey: string;
	/** @internal */
	kind: "git_ssh";
	/** @internal */
	credentialRef: string;
	/** Secret values; valid only while preparing worker.start. */
	/** @internal */
	privateKey: string;
	/** @internal */
	knownHosts: string;
}

/** @internal */
export interface WorkerGitHttpsCredential {
	/** @internal */
	projectKey: string;
	/** @internal */
	kind: "git_https";
	/** @internal */
	credentialRef: string;
	/** Exact non-secret HTTPS clone URL authorized by the server. */
	/** @internal */
	repositoryUrl: string;
	/** @internal */
	username: string;
	/** Secret; only delivered through authenticated worker.start. */
	/** @internal */
	password: string;
}

/** @internal */
export type WorkerRepositoryCredential = WorkerGitSshCredential | WorkerGitHttpsCredential;

/** @internal */
export interface LlmWorkerStartBootstrap {
	/** @internal */
	kind: "llm";
	/** @internal */
	resourceBundle: {
		/** @internal */
		digest: string;
		/** Present for a newly assembled bundle; omitted when the worker can reuse its process volume. */
		/** @internal */
		archiveBase64?: string;
	};
	/** @internal */
	credential: WorkerCredentialMaterial | null;
}

/** @internal */
export interface AutomaticWorkerStartBootstrap {
	/** @internal */
	kind: "automatic";
}

/** @internal */
export type WorkerRuntimeSettingsSnapshot = ConfigSnapshot["workers"];

/** @internal */
export interface DevelopmentToolsStartConfig {
	/** @internal */
	runner: "local" | "isolated";
	/** @internal */
	miseCommand: string;
	/** @internal */
	installTimeoutMs: number;
	/** @internal */
	processStorageRoot: string;
}

/** @internal */
export interface IntegrationToolDeclaration {
	/** @internal */
	name: string;
	/** @internal */
	description: string;
	/** @internal */
	parameters: Record<string, unknown>;
}

/** @internal */
interface WorkerStartPayloadBase extends WorkerRuntimeContextSnapshot {
	/** @internal */
	workerLeaseId: string;
	/** @internal */
	turnStart: TurnStartRecord;
	/**
	 * The immutable pre-acceptance tree plan from the lease that first accepted
	 * this start. It is supplied only when a replacement resumes a running turn.
	 */
	/** @internal */
	acceptedPreparedStart?: PreparedTurnStart | null;
	/** @internal */
	pendingInputs: InputDelivery[];
	/** @internal */
	treePaths: {
		/** @internal */
		primaryTreeFile: string;
		/** @internal */
		workspaceRoot: string;
		/** Process-scoped persistent storage for immutable Pi resource bundles. */
		/** @internal */
		piResourceBundlesDir: string;
	};
	/** @internal */
	resume: boolean;
	/** @internal */
	resumeLeafEntryId?: string | null;
	/** Durable non-secret preparation checkpoint reused by a replacement or Continue start. */
	/** @internal */
	llmPreparation?: {
		/** @internal */
		sourceTurnRecordId: string;
		/** @internal */
		data: unknown;
	};
	/** Fresh secret material resolved for this physical worker start only. */
	/** @internal */
	repositoryCredentials?: WorkerRepositoryCredential[];
	/** Non-secret lifecycle settings supplied to every worker bootstrap type. */
	/** @internal */
	workerRuntimeSettings?: WorkerRuntimeSettingsSnapshot;
	/** Non-secret mise adapter settings. Ignored unless the process opts in. */
	/** @internal */
	developmentTools?: DevelopmentToolsStartConfig;
	/** Non-secret declarations authorized for the selected LLM turn. */
	/** @internal */
	integrationTools?: IntegrationToolDeclaration[];
}

/** @internal */
export type WorkerStartPayload =
	| (WorkerStartPayloadBase & {
			/** @internal */
			bootstrap: LlmWorkerStartBootstrap;
			/** @internal */
			configSnapshot: ConfigSnapshot;
	  })
	| (WorkerStartPayloadBase & {
			/** @internal */
			bootstrap: AutomaticWorkerStartBootstrap;
	  });

/** @internal */
export interface InputBatchPayload {
	/** @internal */
	inputs: InputDelivery[];
}

/** @internal */
export interface WorkerStopPayload {
	/** @internal */
	reason: string;
}

/** @internal */
export interface WorkerAbortTurnPayload {
	/** @internal */
	reason: string;
}

/** @internal */
export interface WorkerTurnStartAcceptedPayload {
	/** @internal */
	startRecordId: string;
	/** @internal */
	turnRecordId: string;
}

/** @internal */
export interface WorkerTurnTerminalRecordedPayload {
	/** @internal */
	turnRecordId: string;
}

/** @internal */
export interface WorkerQuestionResponsePayload {
	/** @internal */
	turnRecordId: string;
	/** @internal */
	toolCallId: string;
	/** @internal */
	answers: string[];
}

/** @internal */
export interface WorkerQuestionRequestedPayload {
	/** @internal */
	turnRecordId: string;
	/** @internal */
	toolCallId: string;
	/** @internal */
	questions: NormalizedQuestion[];
}

/** @internal */
export interface WorkerIntegrationToolRequestPayload {
	/** @internal */
	turnRecordId: string;
	/** @internal */
	toolCallId: string;
	/** @internal */
	toolName: string;
	/** @internal */
	args: Record<string, unknown>;
}

/** @internal */
export interface WorkerIntegrationToolCancelPayload {
	/** @internal */
	turnRecordId: string;
	/** @internal */
	toolCallId: string;
	/** @internal */
	toolName: string;
}

/** @internal */
export interface WorkerIntegrationToolResultPayload {
	/** @internal */
	turnRecordId: string;
	/** @internal */
	toolCallId: string;
	/** @internal */
	ok: boolean;
	/** @internal */
	result?: unknown;
	/** @internal */
	error?: string;
}

/** @internal */
export interface WorkerCredentialUpdateResultPayload {
	/** @internal */
	providerId: string;
	/** @internal */
	accepted: boolean;
	/** @internal */
	currentRevision: number | null;
	/** @internal */
	safeReason?: string;
}

/** @internal */
export type ServerToWorkerMessage =
	| (Omit<IpcEnvelope, "type" | "payload"> & {
			/** @internal */
			type: "worker.start";
			/** @internal */
			payload: WorkerStartPayload;
	  })
	| (Omit<IpcEnvelope, "type" | "payload"> & {
			/** @internal */
			type: "worker.turn_start_accepted";
			/** @internal */
			payload: WorkerTurnStartAcceptedPayload;
	  })
	| (Omit<IpcEnvelope, "type" | "payload"> & {
			/** @internal */
			type: "worker.turn_terminal_recorded";
			/** @internal */
			payload: WorkerTurnTerminalRecordedPayload;
	  })
	| (Omit<IpcEnvelope, "type" | "payload"> & {
			/** @internal */
			type: "worker.credential_update_accepted";
			/** @internal */
			payload: WorkerCredentialUpdateResultPayload;
	  })
	| (Omit<IpcEnvelope, "type" | "payload"> & {
			/** @internal */
			type: "worker.question_response";
			/** @internal */
			payload: WorkerQuestionResponsePayload;
	  })
	| (Omit<IpcEnvelope, "type" | "payload"> & {
			/** @internal */
			type: "worker.integration_tool_result";
			/** @internal */
			payload: WorkerIntegrationToolResultPayload;
	  })
	| (Omit<IpcEnvelope, "type" | "payload"> & {
			/** @internal */
			type: "input.batch";
			/** @internal */
			payload: InputBatchPayload;
	  })
	| (Omit<IpcEnvelope, "type" | "payload"> & {
			/** @internal */
			type: "worker.stop";
			/** @internal */
			payload: WorkerStopPayload;
	  })
	| (Omit<IpcEnvelope, "type" | "payload"> & {
			/** @internal */
			type: "worker.abort_turn";
			/** @internal */
			payload: WorkerAbortTurnPayload;
	  });

/** @internal */
export interface WorkerHelloPayload {
	/** Package/runtime version for diagnostics. */
	/** @internal */
	version: string;
	/** Server-worker API compatibility version. Missing only on legacy/test workers. */
	/** @internal */
	apiVersion?: string;
	/** @internal */
	capabilities: string[];
}

/** @internal */
export interface WorkerBootstrapProgressPayload {
	/** @internal */
	phase: "worker_connected" | "preparing_workspace" | "loading_resources" | "preparing_turn";
}

/** @internal */
export interface WorkerDiagnosticTracePayload {
	/** @internal */
	text: string;
}

/** @internal */
export interface WorkerReadyPayload {
	/** @internal */
	receipt: WorkerBootstrapReceipt;
	/** @internal */
	developmentTools?: {
		/** @internal */
		miseVersion: string;
		/** @internal */
		repositories: Array<{
			/** @internal */
			repositoryKey: string;
			/** @internal */
			tools: Array<{
				/** @internal */
				name: string;
				/** @internal */
				version: string;
			}>;
		}>;
		/** @internal */
		warnings: string[];
	};
	/** @internal */
	resumed: boolean;
	/** @internal */
	primaryTreeFile: string;
	/** @internal */
	workspaceRoot: string;
	/** @internal */
	aggregatedAgentsSources: string[];
	/** @internal */
	loadedSkills: string[];
	/** @internal */
	loadedAgentsFiles: Array<{
		/** @internal */
		path: string;
		/** @internal */
		sizeBytes: number;
	}>;
	/** @internal */
	loadedSkillFiles: Array<{
		/** @internal */
		name: string;
		/** @internal */
		path: string;
	}>;
	/** @internal */
	rootEntryId?: string | null;
}

/** @internal */
export interface WorkerHeartbeatPayload {
	/** Diagnostic worker-local runtime state; not the authoritative lease transition channel. */
	/** @internal */
	state: string;
	/** @internal */
	lastSequenceConsumed: number;
	/** @internal */
	currentTurnId?: string;
	/** @internal */
	currentSelectedTurnId?: string | null;
}

/** @internal */
export interface WorkerStatePayload {
	/** Explicit server-visible runtime transition, e.g. idle -> busy or busy -> idle. */
	/** @internal */
	from: string;
	/** @internal */
	to: string;
	/** @internal */
	reason: string;
}

/** @internal */
export interface WorkerInputConsumedPayload {
	/** @internal */
	inputId: string;
	/** @internal */
	sequence: number;
	/** @internal */
	deliveryMode: string;
	/** @internal */
	currentPrimaryPathLeafId?: string | null;
	/** @internal */
	rootEntryId?: string | null;
	/** @internal */
	targetSemanticRef?: ProcessSemanticEntryRefKey | null;
	/** @internal */
	targetProductName?: string | null;
	/** @internal */
	targetEntryId?: string | null;
}

/** @internal */
export interface WorkerEventPayload {
	/** @internal */
	eventType: string;
	/** @internal */
	selectedTurnId?: string | null;
	/**
	 * Object-shaped event data emitted by trusted worker senders. Decode helpers
	 * do not deeply validate this field at runtime; they only narrow it at the
	 * protocol boundary after envelope + message-type validation.
	 */
	/** @internal */
	data: Record<string, unknown>;
}

/** @internal */
export interface WorkerTurnStartedPayload {
	/** @internal */
	startRecordId: string;
	/** @internal */
	proposedTurnRecordId: string;
}

/** @internal */
export interface WorkerCredentialUpdatePayload {
	/** @internal */
	providerId: string;
	/** @internal */
	expectedRevision: number;
	/** Secret payload. It must not be copied into receipts, events, or turn state. */
	/** @internal */
	values: Record<string, string>;
}

/** @internal */
export interface WorkerTurnOutcomePayload
	extends Omit<TurnOutcomePayload, "instanceId" | "state"> {}

/** @internal */
export interface WorkerTurnFailedPayload
	extends Omit<TurnFailedPayload, "instanceId" | "errorClass"> {
	/** @internal */
	errorClass?: string;
}

/** @internal */
export interface WorkerLifecycleParkedPayload {
	/** @internal */
	selectedTurnId: string | null;
	/** @internal */
	reason?: string;
	/** @internal */
	errorClass?: string;
}

/** @internal */
export interface WorkerCleanupStartedPayload {
	/** @internal */
	reason: string;
}

/** @internal */
export interface WorkerCleanupCompletedPayload {
	/** @internal */
	releasedLocks: string[];
	/** @internal */
	removedTransientPaths: string[];
}

/** @internal */
export interface WorkerFailedPayload {
	/** @internal */
	state: string;
	/** @internal */
	errorCode: string;
	/** @internal */
	message: string;
	/** @internal */
	errorClass: string;
	/** @internal */
	selectedTurnId?: string | null;
	/** @internal */
	retryAttempt?: number;
}

/** @internal */
export type WorkerToServerMessage =
	| (Omit<IpcEnvelope, "type" | "payload"> & {
			/** @internal */
			type: "worker.hello";
			/** @internal */
			payload: WorkerHelloPayload;
	  })
	| (Omit<IpcEnvelope, "type" | "payload"> & {
			/** @internal */
			type: "worker.credential_update";
			/** @internal */
			payload: WorkerCredentialUpdatePayload;
	  })
	| (Omit<IpcEnvelope, "type" | "payload"> & {
			/** @internal */
			type: "worker.bootstrap_progress";
			/** @internal */
			payload: WorkerBootstrapProgressPayload;
	  })
	| (Omit<IpcEnvelope, "type" | "payload"> & {
			/** @internal */
			type: "worker.diagnostic_trace";
			/** @internal */
			payload: WorkerDiagnosticTracePayload;
	  })
	| (Omit<IpcEnvelope, "type" | "payload"> & {
			/** @internal */
			type: "worker.ready";
			/** @internal */
			payload: WorkerReadyPayload;
	  })
	| (Omit<IpcEnvelope, "type" | "payload"> & {
			/** @internal */
			type: "worker.heartbeat";
			/** @internal */
			payload: WorkerHeartbeatPayload;
	  })
	| (Omit<IpcEnvelope, "type" | "payload"> & {
			/** @internal */
			type: "worker.state";
			/** @internal */
			payload: WorkerStatePayload;
	  })
	| (Omit<IpcEnvelope, "type" | "payload"> & {
			/** @internal */
			type: "worker.input_consumed";
			/** @internal */
			payload: WorkerInputConsumedPayload;
	  })
	| (Omit<IpcEnvelope, "type" | "payload"> & {
			/** @internal */
			type: "worker.event";
			/** @internal */
			payload: WorkerEventPayload;
	  })
	| (Omit<IpcEnvelope, "type" | "payload"> & {
			/** @internal */
			type: "worker.turn_started";
			/** @internal */
			payload: WorkerTurnStartedPayload;
	  })
	| (Omit<IpcEnvelope, "type" | "payload"> & {
			/** @internal */
			type: "worker.question_requested";
			/** @internal */
			payload: WorkerQuestionRequestedPayload;
	  })
	| (Omit<IpcEnvelope, "type" | "payload"> & {
			/** @internal */
			type: "worker.integration_tool_request";
			/** @internal */
			payload: WorkerIntegrationToolRequestPayload;
	  })
	| (Omit<IpcEnvelope, "type" | "payload"> & {
			/** @internal */
			type: "worker.integration_tool_cancel";
			/** @internal */
			payload: WorkerIntegrationToolCancelPayload;
	  })
	| (Omit<IpcEnvelope, "type" | "payload"> & {
			/** @internal */
			type: "worker.turn_outcome";
			/** @internal */
			payload: WorkerTurnOutcomePayload;
	  })
	| (Omit<IpcEnvelope, "type" | "payload"> & {
			/** @internal */
			type: "worker.turn_failed";
			/** @internal */
			payload: WorkerTurnFailedPayload;
	  })
	| (Omit<IpcEnvelope, "type" | "payload"> & {
			/** @internal */
			type: "worker.lifecycle_parked";
			/** @internal */
			payload: WorkerLifecycleParkedPayload;
	  })
	| (Omit<IpcEnvelope, "type" | "payload"> & {
			/** @internal */
			type: "worker.cleanup_started";
			/** @internal */
			payload: WorkerCleanupStartedPayload;
	  })
	| (Omit<IpcEnvelope, "type" | "payload"> & {
			/** @internal */
			type: "worker.cleanup_completed";
			/** @internal */
			payload: WorkerCleanupCompletedPayload;
	  })
	| (Omit<IpcEnvelope, "type" | "payload"> & {
			/** @internal */
			type: "worker.failed";
			/** @internal */
			payload: WorkerFailedPayload;
	  });

/** @internal */
export type AnyIpcMessage = ServerToWorkerMessage | WorkerToServerMessage;
/** @internal */
export type IpcMessageType = AnyIpcMessage["type"];
/** @internal */
export type IpcMessageOfType<TType extends IpcMessageType> = Extract<
	AnyIpcMessage,
	{
		/** @internal */
		type: TType;
	}
>;

/** @internal */
export function createIpcMessage<TMessage extends AnyIpcMessage>(
	args: Omit<TMessage, "protocol" | "sentAt"> & {
		/** @internal */
		sentAt?: string;
	},
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
