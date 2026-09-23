import { createApiTokenRepo } from "./api-token-repo.js";
import { createStartupObservationRepo } from "./startup-observation-repo.js";
import { createTurnSummaryRepo } from "./turn-summary-repo.js";

export * from "./api-token-repo.js";

import { createAuthLoginFlowRepo, createAuthSessionRepo } from "./auth-repo.js";
import { type CredentialCipher, createUnavailableCredentialCipher } from "./credential-cipher.js";
import type { LeitwerkDb } from "./database.js";
import { createExternalWriteLogRepo } from "./external-write-log-repo.js";

export * from "./auth-repo.js";
export * from "./credential-cipher.js";
export * from "./external-write-log-repo.js";
export * from "./future-execution-repo.js";
export * from "./launch-run-repo.js";
export * from "./launcher-recent-value-repo.js";
export * from "./mapped-llm-run-repo.js";
export * from "./pending-external-source-fire-repo.js";
export * from "./process-event-repo.js";
export * from "./process-handoff-dedup-key-repo.js";
export * from "./process-input-repo.js";
export * from "./process-instance-repo.js";
export * from "./process-leaf-outcome-snapshot-repo.js";
export * from "./process-project-repo.js";
export * from "./process-question-request-repo.js";
export * from "./process-relation-repo.js";
export * from "./process-skill-repo.js";
export * from "./process-title-job-repo.js";
export * from "./process-tool-approval-request-repo.js";
export * from "./process-turn-annotation-repo.js";
export * from "./process-turn-record-repo.js";
export * from "./provider-credential-repo.js";
export * from "./session-transfer-repo.js";
export * from "./skill-repo.js";
export * from "./ticket-destination-recent-repo.js";
export * from "./turn-start-record-repo.js";
export * from "./worker-lease-repo.js";

import { createFutureExecutionRepo } from "./future-execution-repo.js";
import { createLaunchRunRepo } from "./launch-run-repo.js";
import { createLauncherRecentValueRepo } from "./launcher-recent-value-repo.js";
import { createMappedLlmRunRepo } from "./mapped-llm-run-repo.js";
import { createPendingExternalSourceFireRepo } from "./pending-external-source-fire-repo.js";
import { createProcessEventRepo } from "./process-event-repo.js";
import { createProcessHandoffDedupKeyRepo } from "./process-handoff-dedup-key-repo.js";
import { createProcessInputRepo } from "./process-input-repo.js";
import { createProcessInstanceRepo } from "./process-instance-repo.js";
import { createProcessLeafOutcomeSnapshotRepo } from "./process-leaf-outcome-snapshot-repo.js";
import { createProcessProjectRepo } from "./process-project-repo.js";
import { createProcessQuestionRequestRepo } from "./process-question-request-repo.js";
import { createProcessRelationRepo } from "./process-relation-repo.js";
import { createProcessSkillRepo } from "./process-skill-repo.js";
import { createProcessTitleJobRepo } from "./process-title-job-repo.js";
import { createProcessToolApprovalRequestRepo } from "./process-tool-approval-request-repo.js";
import { createProcessTurnAnnotationRepo } from "./process-turn-annotation-repo.js";
import { createProcessTurnRecordRepo } from "./process-turn-record-repo.js";
import { createProviderCredentialRepo } from "./provider-credential-repo.js";
import { createSessionTransferRepo } from "./session-transfer-repo.js";
import { createSkillRepo } from "./skill-repo.js";
import { createTicketDestinationRecentRepo } from "./ticket-destination-recent-repo.js";
import { createTurnStartRecordRepo } from "./turn-start-record-repo.js";
import { createWorkerLeaseRepo } from "./worker-lease-repo.js";

// ── Repository bundle ──

/** @public */
export interface RepositoryBundle {
	/** @internal */
	startupObservations: ReturnType<typeof createStartupObservationRepo>;
	/** @internal */
	turnSummaries: ReturnType<typeof createTurnSummaryRepo>;
	/** @public */
	processes: ReturnType<typeof createProcessInstanceRepo>;
	/** @public */
	projects: ReturnType<typeof createProcessProjectRepo>;
	/** @internal */
	questionRequests: ReturnType<typeof createProcessQuestionRequestRepo>;
	/** @internal */
	processRelations: ReturnType<typeof createProcessRelationRepo>;
	/** @internal */
	toolApprovalRequests: ReturnType<typeof createProcessToolApprovalRequestRepo>;
	/** @internal */
	inputs: ReturnType<typeof createProcessInputRepo>;
	/** @internal */
	events: ReturnType<typeof createProcessEventRepo>;
	/** @internal */
	handoffDedupKeys: ReturnType<typeof createProcessHandoffDedupKeyRepo>;
	/** @internal */
	futureExecutions: ReturnType<typeof createFutureExecutionRepo>;
	/** @internal */
	launcherRecentValues: ReturnType<typeof createLauncherRecentValueRepo>;
	/** @internal */
	ticketDestinationRecents: ReturnType<typeof createTicketDestinationRecentRepo>;
	/** @internal */
	launchRuns: ReturnType<typeof createLaunchRunRepo>;
	/** @internal */
	titleJobs: ReturnType<typeof createProcessTitleJobRepo>;
	/** @internal */
	pendingExternalSourceFires: ReturnType<typeof createPendingExternalSourceFireRepo>;
	/** @internal */
	leafOutcomeSnapshots: ReturnType<typeof createProcessLeafOutcomeSnapshotRepo>;
	/** @public */
	turnRecords: ReturnType<typeof createProcessTurnRecordRepo>;
	/** @internal */
	turnStarts: ReturnType<typeof createTurnStartRecordRepo>;
	/** @internal */
	turnAnnotations: ReturnType<typeof createProcessTurnAnnotationRepo>;
	/** @internal */
	mappedRuns: ReturnType<typeof createMappedLlmRunRepo>;
	/** @internal */
	leases: ReturnType<typeof createWorkerLeaseRepo>;
	/** @internal */
	providerCredentials: ReturnType<typeof createProviderCredentialRepo>;
	/** @public */
	externalWrites: ReturnType<typeof createExternalWriteLogRepo>;
	/** @internal */
	sessionTransfers: ReturnType<typeof createSessionTransferRepo>;
	/** @internal */
	skills: ReturnType<typeof createSkillRepo>;
	/** @internal */
	processSkills: ReturnType<typeof createProcessSkillRepo>;
	/** @internal */
	apiTokens: ReturnType<typeof createApiTokenRepo>;
	/** @internal */
	authSessions: ReturnType<typeof createAuthSessionRepo>;
	/** @internal */
	authLoginFlows: ReturnType<typeof createAuthLoginFlowRepo>;
	/** @internal */
	transaction<T>(fn: (repos: RepositoryBundle) => T): T;
}

/** @internal */
export function createAllRepos(
	db: LeitwerkDb,
	options: {
		/** @internal */
		credentialCipher?: CredentialCipher;
	} = {},
): RepositoryBundle {
	const credentialCipher = options.credentialCipher ?? createUnavailableCredentialCipher();
	const bundle: RepositoryBundle = {
		startupObservations: createStartupObservationRepo(db),
		turnSummaries: createTurnSummaryRepo(db),
		processes: createProcessInstanceRepo(db),
		projects: createProcessProjectRepo(db),
		questionRequests: createProcessQuestionRequestRepo(db),
		processRelations: createProcessRelationRepo(db),
		toolApprovalRequests: createProcessToolApprovalRequestRepo(db),
		inputs: createProcessInputRepo(db),
		events: createProcessEventRepo(db),
		handoffDedupKeys: createProcessHandoffDedupKeyRepo(db),
		futureExecutions: createFutureExecutionRepo(db),
		launcherRecentValues: createLauncherRecentValueRepo(db),
		ticketDestinationRecents: createTicketDestinationRecentRepo(db),
		launchRuns: createLaunchRunRepo(db),
		titleJobs: createProcessTitleJobRepo(db),
		pendingExternalSourceFires: createPendingExternalSourceFireRepo(db),
		leafOutcomeSnapshots: createProcessLeafOutcomeSnapshotRepo(db),
		turnRecords: createProcessTurnRecordRepo(db),
		turnStarts: createTurnStartRecordRepo(db),
		turnAnnotations: createProcessTurnAnnotationRepo(db),
		mappedRuns: createMappedLlmRunRepo(db),
		leases: createWorkerLeaseRepo(db),
		providerCredentials: createProviderCredentialRepo(db, credentialCipher),
		externalWrites: createExternalWriteLogRepo(db),
		sessionTransfers: createSessionTransferRepo(db),
		skills: createSkillRepo(db),
		processSkills: createProcessSkillRepo(db),
		apiTokens: createApiTokenRepo(db),
		authSessions: createAuthSessionRepo(db),
		authLoginFlows: createAuthLoginFlowRepo(db),
		transaction<T>(fn: (repos: RepositoryBundle) => T): T {
			const transaction = db.transaction.bind(db) as unknown as (callback: (tx: unknown) => T) => T;
			return transaction((tx) => fn(createAllRepos(tx as LeitwerkDb, { credentialCipher })));
		},
	};
	return bundle;
}
