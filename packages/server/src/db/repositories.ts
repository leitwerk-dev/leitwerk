import { createAuthLoginFlowRepo, createAuthSessionRepo } from "./auth-repo.js";
import { type CredentialCipher, createUnavailableCredentialCipher } from "./credential-cipher.js";
import type { LeitwerkDb } from "./database.js";
import { createExternalWriteLogRepo } from "./external-write-log-repo.js";

export * from "./auth-repo.js";
export * from "./credential-cipher.js";
export * from "./external-write-log-repo.js";
export * from "./future-execution-repo.js";
export * from "./launcher-recent-value-repo.js";
export * from "./pending-external-source-fire-repo.js";
export * from "./process-event-repo.js";
export * from "./process-handoff-dedup-key-repo.js";
export * from "./process-input-repo.js";
export * from "./process-instance-repo.js";
export * from "./process-leaf-outcome-snapshot-repo.js";
export * from "./process-project-repo.js";
export * from "./process-question-request-repo.js";
export * from "./process-skill-repo.js";
export * from "./process-title-job-repo.js";
export * from "./process-turn-annotation-repo.js";
export * from "./process-turn-record-repo.js";
export * from "./provider-credential-repo.js";
export * from "./skill-repo.js";
export * from "./turn-start-record-repo.js";
export * from "./worker-lease-repo.js";

import { createFutureExecutionRepo } from "./future-execution-repo.js";
import { createLauncherRecentValueRepo } from "./launcher-recent-value-repo.js";
import { createPendingExternalSourceFireRepo } from "./pending-external-source-fire-repo.js";
import { createProcessEventRepo } from "./process-event-repo.js";
import { createProcessHandoffDedupKeyRepo } from "./process-handoff-dedup-key-repo.js";
import { createProcessInputRepo } from "./process-input-repo.js";
import { createProcessInstanceRepo } from "./process-instance-repo.js";
import { createProcessLeafOutcomeSnapshotRepo } from "./process-leaf-outcome-snapshot-repo.js";
import { createProcessProjectRepo } from "./process-project-repo.js";
import { createProcessQuestionRequestRepo } from "./process-question-request-repo.js";
import { createProcessSkillRepo } from "./process-skill-repo.js";
import { createProcessTitleJobRepo } from "./process-title-job-repo.js";
import { createProcessTurnAnnotationRepo } from "./process-turn-annotation-repo.js";
import { createProcessTurnRecordRepo } from "./process-turn-record-repo.js";
import { createProviderCredentialRepo } from "./provider-credential-repo.js";
import { createSkillRepo } from "./skill-repo.js";
import { createTurnStartRecordRepo } from "./turn-start-record-repo.js";
import { createWorkerLeaseRepo } from "./worker-lease-repo.js";

// ── Repository bundle ──

export interface RepositoryBundle {
	processes: ReturnType<typeof createProcessInstanceRepo>;
	projects: ReturnType<typeof createProcessProjectRepo>;
	questionRequests: ReturnType<typeof createProcessQuestionRequestRepo>;
	inputs: ReturnType<typeof createProcessInputRepo>;
	events: ReturnType<typeof createProcessEventRepo>;
	handoffDedupKeys: ReturnType<typeof createProcessHandoffDedupKeyRepo>;
	futureExecutions: ReturnType<typeof createFutureExecutionRepo>;
	launcherRecentValues: ReturnType<typeof createLauncherRecentValueRepo>;
	titleJobs: ReturnType<typeof createProcessTitleJobRepo>;
	pendingExternalSourceFires: ReturnType<typeof createPendingExternalSourceFireRepo>;
	leafOutcomeSnapshots: ReturnType<typeof createProcessLeafOutcomeSnapshotRepo>;
	turnRecords: ReturnType<typeof createProcessTurnRecordRepo>;
	turnStarts: ReturnType<typeof createTurnStartRecordRepo>;
	turnAnnotations: ReturnType<typeof createProcessTurnAnnotationRepo>;
	leases: ReturnType<typeof createWorkerLeaseRepo>;
	providerCredentials: ReturnType<typeof createProviderCredentialRepo>;
	externalWrites: ReturnType<typeof createExternalWriteLogRepo>;
	skills: ReturnType<typeof createSkillRepo>;
	processSkills: ReturnType<typeof createProcessSkillRepo>;
	authSessions: ReturnType<typeof createAuthSessionRepo>;
	authLoginFlows: ReturnType<typeof createAuthLoginFlowRepo>;
	transaction<T>(fn: (repos: RepositoryBundle) => T): T;
}

export function createAllRepos(
	db: LeitwerkDb,
	options: { credentialCipher?: CredentialCipher } = {},
): RepositoryBundle {
	const credentialCipher = options.credentialCipher ?? createUnavailableCredentialCipher();
	const bundle: RepositoryBundle = {
		processes: createProcessInstanceRepo(db),
		projects: createProcessProjectRepo(db),
		questionRequests: createProcessQuestionRequestRepo(db),
		inputs: createProcessInputRepo(db),
		events: createProcessEventRepo(db),
		handoffDedupKeys: createProcessHandoffDedupKeyRepo(db),
		futureExecutions: createFutureExecutionRepo(db),
		launcherRecentValues: createLauncherRecentValueRepo(db),
		titleJobs: createProcessTitleJobRepo(db),
		pendingExternalSourceFires: createPendingExternalSourceFireRepo(db),
		leafOutcomeSnapshots: createProcessLeafOutcomeSnapshotRepo(db),
		turnRecords: createProcessTurnRecordRepo(db),
		turnStarts: createTurnStartRecordRepo(db),
		turnAnnotations: createProcessTurnAnnotationRepo(db),
		leases: createWorkerLeaseRepo(db),
		providerCredentials: createProviderCredentialRepo(db, credentialCipher),
		externalWrites: createExternalWriteLogRepo(db),
		skills: createSkillRepo(db),
		processSkills: createProcessSkillRepo(db),
		authSessions: createAuthSessionRepo(db),
		authLoginFlows: createAuthLoginFlowRepo(db),
		transaction<T>(fn: (repos: RepositoryBundle) => T): T {
			return db.transaction((tx) =>
				fn(createAllRepos(tx as unknown as LeitwerkDb, { credentialCipher })),
			);
		},
	};
	return bundle;
}
