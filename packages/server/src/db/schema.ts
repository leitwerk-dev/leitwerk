import { SERIALIZED_SYSTEM_ACTOR } from "@leitwerk-dev/domain";
import { sql } from "drizzle-orm";
import {
	blob,
	check,
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const processInstances = sqliteTable(
	"process_instances",
	{
		id: text("id").primaryKey(),
		processId: text("process_id").notNull(),
		selectedTurnId: text("selected_turn_id"),
		lifecycleStatus: text("lifecycle_status").notNull().default("discovered"),
		currentWorkerStartId: text("current_worker_start_id"),
		currentServerTurnRecordId: text("current_server_turn_record_id"),
		planRevision: integer("plan_revision").notNull().default(0),
		title: text("title"),
		externalId: text("external_id"),
		externalUrl: text("external_url"),
		metadata: text("metadata"),
		defaultModelProfileId: text("default_model_profile_id"),
		turnConfigsJson: text("turn_configs_json"),
		selectedTurnModelProfileId: text("selected_turn_model_profile_id"),
		paramsJson: text("params_json"),
		stateJson: text("state_json"),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
		closedAt: text("closed_at"),
		// ALTER TABLE appends migrated columns; keep these in migration order so
		// durable databases and newly initialized databases have the same schema.
		initialDefaultModelProfileId: text("initial_default_model_profile_id"),
		selectedTurnModelSource: text("selected_turn_model_source"),
		selectedTurnModelKind: text("selected_turn_model_kind"),
		launchIntentJson: text("launch_intent_json"),
	},
	(t) => [
		check(
			"process_instances_one_current_execution",
			sql`not (${t.currentWorkerStartId} is not null and ${t.currentServerTurnRecordId} is not null)`,
		),
		index("idx_process_instances_selected_turn").on(t.selectedTurnId),
		index("idx_process_instances_external_id").on(t.externalId),
		index("idx_process_instances_process").on(t.processId),
	],
);

export const skills = sqliteTable("skills", {
	id: text("id").primaryKey(),
	label: text("label").notNull(),
	description: text("description"),
	activeRevisionId: text("active_revision_id"),
	createdAt: text("created_at").notNull(),
	updatedAt: text("updated_at").notNull(),
	registrationKind: text("registration_kind", { enum: ["configuration", "catalog"] })
		.notNull()
		.default("configuration"),
});

export const skillRevisions = sqliteTable(
	"skill_revisions",
	{
		id: text("id").primaryKey(),
		skillId: text("skill_id")
			.notNull()
			.references(() => skills.id),
		bundleDigest: text("bundle_digest").notNull(),
		bundleBytes: blob("bundle_bytes", { mode: "buffer" }).notNull(),
		sourceRevision: text("source_revision"),
		importedAt: text("imported_at").notNull(),
	},
	(t) => [uniqueIndex("uq_skill_revisions_skill_digest").on(t.skillId, t.bundleDigest)],
);

export const skillRevisionDependencies = sqliteTable(
	"skill_revision_dependencies",
	{
		skillRevisionId: text("skill_revision_id")
			.notNull()
			.references(() => skillRevisions.id, { onDelete: "cascade" }),
		dependencySkillId: text("dependency_skill_id").notNull(),
		position: integer("position").notNull(),
	},
	(t) => [
		uniqueIndex("uq_skill_revision_dependency").on(t.skillRevisionId, t.dependencySkillId),
		uniqueIndex("uq_skill_revision_dependency_position").on(t.skillRevisionId, t.position),
	],
);

export const skillCatalogEntries = sqliteTable(
	"skill_catalog_entries",
	{
		repositoryId: text("repository_id").notNull(),
		skillId: text("skill_id").notNull(),
		label: text("label").notNull(),
		description: text("description"),
		sourcePath: text("source_path").notNull(),
		sourceRevision: text("source_revision").notNull(),
		bundleDigest: text("bundle_digest").notNull(),
		bundleBytes: blob("bundle_bytes", { mode: "buffer" }).notNull(),
		discoveredAt: text("discovered_at").notNull(),
		available: integer("available", { mode: "boolean" }).notNull().default(true),
	},
	(t) => [
		uniqueIndex("uq_skill_catalog_entry").on(t.repositoryId, t.skillId),
		index("idx_skill_catalog_skill").on(t.skillId),
	],
);

export const processSkills = sqliteTable(
	"process_skills",
	{
		instanceId: text("instance_id")
			.notNull()
			.references(() => processInstances.id, { onDelete: "cascade" }),
		skillId: text("skill_id")
			.notNull()
			.references(() => skills.id),
		skillRevisionId: text("skill_revision_id")
			.notNull()
			.references(() => skillRevisions.id),
		position: integer("position").notNull(),
	},
	(t) => [
		uniqueIndex("uq_process_skills_instance_skill").on(t.instanceId, t.skillId),
		uniqueIndex("uq_process_skills_instance_position").on(t.instanceId, t.position),
	],
);

export const skillInvocations = sqliteTable(
	"skill_invocations",
	{
		instanceId: text("instance_id")
			.notNull()
			.references(() => processInstances.id, { onDelete: "cascade" }),
		turnRecordId: text("turn_record_id").notNull(),
		skillId: text("skill_id")
			.notNull()
			.references(() => skills.id),
		skillRevisionId: text("skill_revision_id")
			.notNull()
			.references(() => skillRevisions.id),
		invokedAt: text("invoked_at").notNull(),
	},
	(t) => [
		uniqueIndex("uq_skill_invocation_turn_skill").on(t.turnRecordId, t.skillId),
		index("idx_skill_invocations_skill_time").on(t.skillId, t.invokedAt),
	],
);

export const processProjects = sqliteTable(
	"process_projects",
	{
		id: text("id").primaryKey(),
		instanceId: text("instance_id")
			.notNull()
			.references(() => processInstances.id, { onDelete: "cascade" }),
		key: text("key").notNull(),
		repoLocator: text("repo_locator").notNull(),
		repoLocatorKind: text("repo_locator_kind").notNull(),
		baseBranch: text("base_branch").notNull(),
		workBranch: text("work_branch"),
		externalId: text("external_id"),
		externalUrl: text("external_url"),
		metadata: text("metadata"),
		pipelineStatus: text("pipeline_status"),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(t) => [
		index("idx_process_projects_instance").on(t.instanceId),
		uniqueIndex("uq_process_projects_instance_key").on(t.instanceId, t.key),
	],
);

export const processInputs = sqliteTable(
	"process_inputs",
	{
		id: text("id").primaryKey(),
		instanceId: text("instance_id")
			.notNull()
			.references(() => processInstances.id, { onDelete: "cascade" }),
		sequence: integer("sequence").notNull(),
		source: text("source").notNull(),
		kind: text("kind").notNull(),
		targetSemanticRef: text("target_semantic_ref"),
		targetProductName: text("target_product_name"),
		bodyMarkdown: text("body_markdown").notNull(),
		receivedAt: text("received_at").notNull(),
		consumedAt: text("consumed_at"),
		// Appended last to match `ALTER TABLE ... ADD COLUMN` ordering so a migrated
		// database stays schema-compatible with a freshly created one. The default is
		// the canonical serialized SYSTEM_ACTOR so the schema column default and the
		// runtime fallback share a single source of truth; the migration SQL must keep
		// the same literal, which the startup schema-compatibility guard enforces.
		actor: text("actor").notNull().default(SERIALIZED_SYSTEM_ACTOR),
	},
	(t) => [
		index("idx_process_inputs_instance").on(t.instanceId),
		uniqueIndex("uq_process_inputs_instance_seq").on(t.instanceId, t.sequence),
		index("idx_process_inputs_unconsumed").on(t.instanceId, t.consumedAt),
	],
);

export const processEvents = sqliteTable(
	"process_events",
	{
		id: text("id").primaryKey(),
		instanceId: text("instance_id")
			.notNull()
			.references(() => processInstances.id, { onDelete: "cascade" }),
		eventType: text("event_type").notNull(),
		data: text("data").notNull().default("{}"),
		createdAt: text("created_at").notNull(),
	},
	(t) => [
		index("idx_process_events_instance").on(t.instanceId),
		index("idx_process_events_instance_created").on(t.instanceId, t.createdAt),
		index("idx_process_events_type").on(t.eventType),
	],
);

export const futureExecutions = sqliteTable(
	"future_executions",
	{
		id: text("id").primaryKey(),
		kind: text("kind").notNull(),
		scheduleKind: text("schedule_kind").notNull(),
		processId: text("process_id").notNull(),
		instanceId: text("instance_id").references(() => processInstances.id, {
			onDelete: "cascade",
		}),
		launcherId: text("launcher_id"),
		actionId: text("action_id"),
		payloadJson: text("payload_json").notNull(),
		cronExpression: text("cron_expression"),
		nextRunAt: text("next_run_at").notNull(),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
		// Durable model-policy state. Appended in migration order.
		modelProfileId: text("model_profile_id"),
		modelSelectionKind: text("model_selection_kind"),
		modelSelectionSource: text("model_selection_source"),
		blockedReasonJson: text("blocked_reason_json"),
	},
	(t) => [
		index("idx_future_executions_next_run").on(t.nextRunAt),
		index("idx_future_executions_instance").on(t.instanceId),
		index("idx_future_executions_kind").on(t.kind),
		uniqueIndex("uq_future_executions_action_instance")
			.on(t.instanceId)
			.where(sql`${t.kind} = 'action'`),
	],
);

export const launcherRecentValues = sqliteTable(
	"launcher_recent_values",
	{
		id: text("id").primaryKey(),
		launcherId: text("launcher_id").notNull(),
		fieldId: text("field_id").notNull(),
		value: text("value").notNull(),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(t) => [
		index("idx_launcher_recent_values_launcher_field").on(t.launcherId, t.fieldId),
		index("idx_launcher_recent_values_updated").on(t.launcherId, t.fieldId, t.updatedAt),
		uniqueIndex("uq_launcher_recent_values_value").on(t.launcherId, t.fieldId, t.value),
	],
);

export const processTitleJobs = sqliteTable(
	"process_title_jobs",
	{
		id: text("id").primaryKey(),
		targetKind: text("target_kind").notNull(),
		processDefinitionId: text("process_definition_id").notNull(),
		processInstanceId: text("process_instance_id").references(() => processInstances.id, {
			onDelete: "cascade",
		}),
		futureExecutionId: text("future_execution_id").references(() => futureExecutions.id, {
			onDelete: "cascade",
		}),
		modelProfileId: text("model_profile_id").notNull(),
		prompt: text("prompt").notNull(),
		expectedPayloadJson: text("expected_payload_json"),
		status: text("status").notNull(),
		attemptCount: integer("attempt_count").notNull().default(0),
		maxAttempts: integer("max_attempts").notNull(),
		nextRunAt: text("next_run_at").notNull(),
		lastError: text("last_error"),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(t) => [
		index("idx_process_title_jobs_due").on(t.status, t.nextRunAt),
		index("idx_process_title_jobs_process_instance").on(t.processInstanceId),
		index("idx_process_title_jobs_future_execution").on(t.futureExecutionId),
	],
);

export const processHandoffDedupKeys = sqliteTable(
	"process_handoff_dedup_keys",
	{
		key: text("key").primaryKey(),
		instanceId: text("instance_id")
			.notNull()
			.references(() => processInstances.id, { onDelete: "cascade" }),
		createdAt: text("created_at").notNull(),
		metadata: text("metadata").notNull().default("{}"),
	},
	(t) => [
		index("idx_handoff_dedup_keys_instance").on(t.instanceId),
		uniqueIndex("uq_handoff_dedup_keys_instance").on(t.instanceId),
	],
);

export const processLeafOutcomeSnapshots = sqliteTable(
	"process_leaf_outcome_snapshots",
	{
		id: text("id").primaryKey(),
		instanceId: text("instance_id")
			.notNull()
			.references(() => processInstances.id, { onDelete: "cascade" }),
		leafEntryId: text("leaf_entry_id").notNull(),
		turnRecordId: text("turn_record_id"),
		rendererId: text("renderer_id"),
		schemaVersion: integer("schema_version"),
		propsJson: text("props_json"),
		fallbackMarkdown: text("fallback_markdown"),
		status: text("status").notNull(),
		warningCode: text("warning_code"),
		warningMessage: text("warning_message"),
		anchoredAt: text("anchored_at").notNull(),
		createdAt: text("created_at").notNull(),
	},
	(t) => [
		index("idx_leaf_outcome_snapshots_instance").on(t.instanceId),
		index("idx_leaf_outcome_snapshots_instance_anchor").on(t.instanceId, t.anchoredAt),
		uniqueIndex("uq_leaf_outcome_snapshots_instance_leaf").on(t.instanceId, t.leafEntryId),
	],
);

export const turnRecords = sqliteTable(
	"turn_records",
	{
		id: text("id").primaryKey(),
		instanceId: text("instance_id")
			.notNull()
			.references(() => processInstances.id, { onDelete: "cascade" }),
		turnId: text("turn_id").notNull(),
		turnType: text("turn_type").notNull().default("llm"),
		status: text("status").notNull(),
		attemptNumber: integer("attempt_number").notNull().default(1),
		parentTurnRecordId: text("parent_turn_record_id"),
		turnStartRecordId: text("turn_start_record_id"),
		acceptedWorkerLeaseId: text("accepted_worker_lease_id"),
		pathType: text("path_type").notNull().default("primary"),
		forkPiEntryId: text("fork_pi_entry_id"),
		resultPiEntryId: text("result_pi_entry_id"),
		modelProfileId: text("model_profile_id"),
		turnResultMarkdown: text("turn_result_markdown"),
		errorSummary: text("error_summary"),
		errorClass: text("error_class"),
		startedAt: text("started_at").notNull(),
		endedAt: text("ended_at"),
		modelSelectionKind: text("model_selection_kind"),
		modelSelectionSource: text("model_selection_source"),
	},
	(t) => [
		uniqueIndex("uq_turn_records_instance_id").on(t.instanceId, t.id),
		uniqueIndex("uq_turn_records_turn_start_record").on(t.turnStartRecordId),
		index("idx_turn_records_instance").on(t.instanceId),
		index("idx_turn_records_status").on(t.status),
		index("idx_turn_records_instance_started").on(t.instanceId, t.startedAt),
		check(
			"turn_records_worker_start_link",
			sql`((${t.turnType} in ('llm', 'automatic')) and ${t.turnStartRecordId} is not null and ${t.acceptedWorkerLeaseId} is not null) or ((${t.turnType} not in ('llm', 'automatic')) and ${t.turnStartRecordId} is null and ${t.acceptedWorkerLeaseId} is null)`,
		),
		check(
			"turn_records_type",
			sql`${t.turnType} in ('llm', 'human', 'external', 'automatic', 'server_automatic')`,
		),
	],
);

export const turnStartRecords = sqliteTable(
	"turn_start_records",
	{
		id: text("id").primaryKey(),
		instanceId: text("instance_id")
			.notNull()
			.references(() => processInstances.id, { onDelete: "cascade" }),
		turnId: text("turn_id").notNull(),
		turnType: text("turn_type").notNull(),
		proposedTurnRecordId: text("proposed_turn_record_id").notNull(),
		startKind: text("start_kind").notNull(),
		recoveryTurnRecordId: text("recovery_turn_record_id"),
		continuationJson: text("continuation_json"),
		stateJson: text("state_json").notNull(),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(t) => [
		uniqueIndex("uq_turn_start_records_proposed_turn_record").on(t.proposedTurnRecordId),
		uniqueIndex("uq_turn_start_records_instance_id").on(t.instanceId, t.id),
		uniqueIndex("uq_turn_start_records_acceptance_target").on(
			t.id,
			t.instanceId,
			t.proposedTurnRecordId,
			t.turnId,
		),
		index("idx_turn_start_records_instance_created").on(t.instanceId, t.createdAt),
		index("idx_turn_start_records_recovery").on(t.recoveryTurnRecordId),
		check("turn_start_records_type", sql`${t.turnType} in ('llm', 'automatic')`),
		check(
			"turn_start_records_kind",
			sql`${t.startKind} in ('selected_turn', 'retry', 'continue', 'startup_retry')`,
		),
		check(
			"turn_start_records_state",
			sql`json_valid(${t.stateJson}) and json_extract(${t.stateJson}, '$.kind') in ('preparation_failed', 'starting', 'bootstrap_failed', 'accepted', 'superseded')`,
		),
		check(
			"turn_start_records_continuation",
			sql`${t.continuationJson} is null or json_valid(${t.continuationJson})`,
		),
	],
);

export const authSessions = sqliteTable(
	"auth_sessions",
	{
		idHash: text("id_hash").primaryKey(),
		actorId: text("actor_id").notNull(),
		actorProvider: text("actor_provider"),
		displayName: text("display_name"),
		createdAt: text("created_at").notNull(),
		expiresAt: text("expires_at").notNull(),
	},
	(t) => [
		index("idx_auth_sessions_expires").on(t.expiresAt),
		index("idx_auth_sessions_actor").on(t.actorId),
	],
);

export const authLoginFlows = sqliteTable(
	"auth_login_flows",
	{
		idHash: text("id_hash").primaryKey(),
		providerId: text("provider_id").notNull(),
		state: text("state").notNull(),
		pkceVerifier: text("pkce_verifier").notNull(),
		createdAt: text("created_at").notNull(),
		expiresAt: text("expires_at").notNull(),
	},
	(t) => [index("idx_auth_login_flows_expires").on(t.expiresAt)],
);

export const turnAnnotations = sqliteTable(
	"turn_annotations",
	{
		id: text("id").primaryKey(),
		instanceId: text("instance_id")
			.notNull()
			.references(() => processInstances.id, { onDelete: "cascade" }),
		annotationType: text("annotation_type").notNull(),
		/**
		 * Null means append-only: the annotation is valid, but it is not addressable
		 * through key-based upsert/update mechanics.
		 */
		annotationKey: text("annotation_key"),
		referencesJson: text("references_json").notNull().default("[]"),
		payloadJson: text("payload_json").notNull().default("{}"),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(t) => [
		index("idx_turn_annotations_instance").on(t.instanceId),
		index("idx_turn_annotations_type").on(t.annotationType),
		uniqueIndex("uq_turn_annotations_instance_key").on(t.instanceId, t.annotationKey),
	],
);

export const workerLeases = sqliteTable(
	"worker_leases",
	{
		id: text("id").primaryKey(),
		instanceId: text("instance_id")
			.notNull()
			.references(() => processInstances.id, { onDelete: "cascade" }),
		workerId: text("worker_id").notNull(),
		state: text("state").notNull(),
		lastHeartbeatAt: text("last_heartbeat_at"),
		startedAt: text("started_at").notNull(),
		exitedAt: text("exited_at"),
		// Keep migrated columns in `ALTER TABLE ... ADD COLUMN` order for existing DBs.
		serverEpoch: text("server_epoch"),
		snapshotTokenHash: text("snapshot_token_hash"),
		connectTokenHash: text("connect_token_hash"),
		modelPolicyFingerprint: text("model_policy_fingerprint"),
		bootstrapReceiptJson: text("bootstrap_receipt_json"),
	},
	(t) => [
		uniqueIndex("uq_worker_leases_instance_id").on(t.instanceId, t.id),
		index("idx_worker_leases_instance").on(t.instanceId),
		uniqueIndex("uq_worker_leases_worker").on(t.workerId),
		index("idx_worker_leases_state").on(t.state),
	],
);

export const processQuestionRequests = sqliteTable(
	"process_question_requests",
	{
		id: text("id").primaryKey(),
		instanceId: text("instance_id")
			.notNull()
			.references(() => processInstances.id, { onDelete: "cascade" }),
		turnRecordId: text("turn_record_id").notNull(),
		toolCallId: text("tool_call_id").notNull(),
		questionsJson: text("questions_json").notNull(),
		status: text("status").notNull().default("open"),
		answersJson: text("answers_json"),
		askedAt: text("asked_at").notNull(),
		answeredAt: text("answered_at"),
		answeredByJson: text("answered_by_json"),
		cancelledAt: text("cancelled_at"),
	},
	(t) => [
		uniqueIndex("uq_question_requests_turn_tool").on(t.instanceId, t.turnRecordId, t.toolCallId),
		index("idx_question_requests_instance_status").on(t.instanceId, t.status),
		check("question_requests_status", sql`${t.status} in ('open', 'answered', 'cancelled')`),
		check("question_requests_questions_json", sql`json_valid(${t.questionsJson})`),
		check(
			"question_requests_answers_json",
			sql`${t.answersJson} is null or json_valid(${t.answersJson})`,
		),
	],
);

export const providerCredentials = sqliteTable(
	"provider_credentials",
	{
		providerId: text("provider_id").primaryKey(),
		revision: integer("revision").notNull(),
		encryptedPayload: text("encrypted_payload").notNull(),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(t) => [check("provider_credentials_positive_revision", sql`${t.revision} > 0`)],
);

export const pendingExternalSourceFires = sqliteTable(
	"pending_external_source_fires",
	{
		id: text("id").primaryKey(),
		instanceId: text("instance_id")
			.notNull()
			.references(() => processInstances.id, { onDelete: "cascade" }),
		armingId: text("arming_id").notNull(),
		turnId: text("turn_id").notNull(),
		externalActionId: text("external_action_id").notNull(),
		sourceKind: text("source_kind").notNull().default(""),
		inputJson: text("input_json").notNull().default("{}"),
		eventJson: text("event_json").notNull().default("{}"),
		mergeKey: text("merge_key"),
		queuedCount: integer("queued_count").notNull().default(1),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(t) => [
		index("idx_pending_external_fires_instance").on(t.instanceId),
		index("idx_pending_external_fires_arming").on(t.instanceId, t.armingId),
		index("idx_pending_external_fires_created").on(t.createdAt),
		uniqueIndex("uq_pending_external_fires_merge_key")
			.on(t.instanceId, t.armingId, t.mergeKey)
			.where(sql`${t.mergeKey} is not null`),
	],
);

export const externalWriteLog = sqliteTable(
	"external_write_log",
	{
		id: text("id").primaryKey(),
		instanceId: text("instance_id")
			.notNull()
			.references(() => processInstances.id, { onDelete: "cascade" }),
		writeType: text("write_type").notNull(),
		dedupKey: text("dedup_key").notNull(),
		completedAt: text("completed_at").notNull(),
		metadata: text("metadata").notNull().default("{}"),
	},
	(t) => [
		index("idx_ewl_instance").on(t.instanceId),
		uniqueIndex("uq_ewl_dedup_key").on(t.dedupKey),
		index("idx_ewl_write_type").on(t.writeType),
	],
);

/**
 * Composite foreign keys for the cyclic execution graph. Drizzle cannot infer
 * these mutually recursive table types without degrading declarations to any,
 * so the fresh baseline DDL adds them explicitly.
 */
export const BASELINE_TABLE_CONSTRAINTS: Readonly<Record<string, readonly string[]>> = {
	skills: [
		"CONSTRAINT fk_skills_active_revision FOREIGN KEY (active_revision_id) REFERENCES skill_revisions(id)",
	],
	process_instances: [
		"CONSTRAINT fk_process_instances_worker_start FOREIGN KEY (id, current_worker_start_id) REFERENCES turn_start_records(instance_id, id)",
		"CONSTRAINT fk_process_instances_server_turn FOREIGN KEY (id, current_server_turn_record_id) REFERENCES turn_records(instance_id, id)",
	],
	turn_records: [
		"CONSTRAINT fk_turn_records_accepted_start FOREIGN KEY (turn_start_record_id, instance_id, id, turn_id) REFERENCES turn_start_records(id, instance_id, proposed_turn_record_id, turn_id)",
		"CONSTRAINT fk_turn_records_accepted_lease FOREIGN KEY (instance_id, accepted_worker_lease_id) REFERENCES worker_leases(instance_id, id)",
		"CONSTRAINT fk_turn_records_parent FOREIGN KEY (instance_id, parent_turn_record_id) REFERENCES turn_records(instance_id, id)",
	],
	turn_start_records: [
		"CONSTRAINT fk_turn_start_records_recovery FOREIGN KEY (instance_id, recovery_turn_record_id) REFERENCES turn_records(instance_id, id)",
	],
	process_question_requests: [
		"CONSTRAINT fk_question_requests_turn FOREIGN KEY (instance_id, turn_record_id) REFERENCES turn_records(instance_id, id)",
	],
};
