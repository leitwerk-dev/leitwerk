import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/node-sqlite";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import * as schema from "./schema.js";
import { generateCreateIndexDDL, generateCreateTableDDL, getTableName } from "./schema-ddl.js";

export type LeitwerkDb = ReturnType<typeof drizzle>;

export interface DatabaseOptions {
	sqlitePath: string;
	enableWAL?: boolean;
}

export interface InitializeSchemaOptions {
	sqlitePath?: string;
}

export class DatabaseSchemaMismatchError extends Error {
	constructor(
		readonly sqlitePath: string,
		readonly tableName: string,
	) {
		super(
			`SQLite schema mismatch for table "${tableName}" at ${sqlitePath}. ` +
				`Known migrations were applied automatically when possible. Stop the server, ` +
				`back up the configured SQLite database, add or apply the required explicit ` +
				`migration for this unknown drift, and restart. Leitwerk never resets ` +
				`configured storage automatically.`,
		);
		this.name = "DatabaseSchemaMismatchError";
	}
}

const ALL_TABLES = [
	schema.processInstances,
	schema.launchRuns,
	schema.launchRunReplays,
	schema.skills,
	schema.skillRevisions,
	schema.skillRevisionDependencies,
	schema.skillCatalogEntries,
	schema.processSkills,
	schema.skillInvocations,
	schema.processProjects,
	schema.processInputs,
	schema.processEvents,
	schema.processHandoffDedupKeys,
	schema.futureExecutions,
	schema.launcherRecentValues,
	schema.ticketDestinationRecents,
	schema.processTitleJobs,
	schema.pendingExternalSourceFires,
	schema.processLeafOutcomeSnapshots,
	schema.turnRecords,
	schema.turnStartRecords,
	schema.apiTokens,
	schema.authSessions,
	schema.authLoginFlows,
	schema.turnAnnotations,
	schema.workerLeases,
	schema.processQuestionRequests,
	schema.processRelations,
	schema.processToolApprovalRequests,
	schema.providerCredentials,
	schema.sessionTransferGrants,
	schema.sessionTransferAttempts,
	schema.externalWriteLog,
] as const;

function createTableSql(table: SQLiteTable): string {
	return generateCreateTableDDL(
		table,
		schema.BASELINE_TABLE_CONSTRAINTS[getTableName(table)] ?? [],
	);
}

function createTableWithIndexes(sqlite: DatabaseSync, table: SQLiteTable): void {
	sqlite.exec(createTableSql(table));
	for (const statement of generateCreateIndexDDL(table)) sqlite.exec(statement);
}

function existingTableSql(sqlite: DatabaseSync, tableName: string): string | null {
	const row = sqlite
		.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
		.get(tableName) as { sql?: string | null } | undefined;
	return typeof row?.sql === "string" ? row.sql : null;
}

function tableHasColumn(sqlite: DatabaseSync, tableName: string, columnName: string): boolean {
	return (sqlite.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>).some(
		(column) => column.name === columnName,
	);
}

function existingSchemaObjects(sqlite: DatabaseSync, type: "table" | "index"): Map<string, string> {
	const rows = sqlite
		.prepare(
			"SELECT name, sql FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name",
		)
		.all(type) as Array<{ name: string; sql: string | null }>;
	return new Map(rows.flatMap((row) => (row.sql ? [[row.name, row.sql] as const] : [])));
}

function hasExistingSchema(sqlite: DatabaseSync): boolean {
	const row = sqlite
		.prepare(
			"SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
		)
		.get() as { count: number };
	return row.count > 0;
}

function splitCreateTableDefinitions(body: string): string[] {
	const definitions: string[] = [];
	let start = 0;
	let depth = 0;
	let quote: "'" | '"' | "`" | "[" | null = null;
	for (let index = 0; index < body.length; index++) {
		const character = body[index];
		if (quote !== null) {
			if (quote === "[" ? character === "]" : character === quote) {
				if (body[index + 1] === character && quote !== "[") {
					index++;
				} else {
					quote = null;
				}
			}
			continue;
		}
		if (character === "'" || character === '"' || character === "`" || character === "[") {
			quote = character;
		} else if (character === "(") {
			depth++;
		} else if (character === ")") {
			depth--;
		} else if (character === "," && depth === 0) {
			definitions.push(body.slice(start, index));
			start = index + 1;
		}
	}
	definitions.push(body.slice(start));
	return definitions;
}

function normalizeCreateTableSql(sql: string): string {
	const compact = sql
		.toLowerCase()
		.replace(/create\s+table\s+if\s+not\s+exists/g, "create table")
		.replace(/\s+/g, "")
		.trim();
	const openingParenthesis = compact.indexOf("(");
	const closingParenthesis = compact.lastIndexOf(")");
	if (openingParenthesis < 0 || closingParenthesis <= openingParenthesis) return compact;
	const body = compact.slice(openingParenthesis + 1, closingParenthesis);
	const definitions = splitCreateTableDefinitions(body).sort();
	return `${compact.slice(0, openingParenthesis + 1)}${definitions.join(",")}${compact.slice(closingParenthesis)}`;
}

function normalizeSchemaSql(sql: string): string {
	return normalizeCreateTableSql(sql).replace(/create(unique)?indexifnotexists/g, "create$1index");
}

function assertCompatibleTableSchema(
	sqlite: DatabaseSync,
	table: SQLiteTable,
	sqlitePath: string,
): void {
	const tableName = getTableName(table);
	const actualSql = existingTableSql(sqlite, tableName);
	const expectedSql = createTableSql(table);
	if (!actualSql || normalizeCreateTableSql(actualSql) !== normalizeCreateTableSql(expectedSql)) {
		throw new DatabaseSchemaMismatchError(sqlitePath, tableName);
	}
}

function assertBaselineSchema(
	sqlite: DatabaseSync,
	sqlitePath: string,
	migratingTables: ReadonlySet<string> = new Set(),
	migratingLegacyIndexes: ReadonlySet<string> = new Set(),
): void {
	const actualTables = existingSchemaObjects(sqlite, "table");
	const expectedTableNames = new Set([...ALL_TABLES.map(getTableName), ...migratingTables]);
	const unknownTable = [...actualTables.keys()].find((name) => !expectedTableNames.has(name));
	if (unknownTable) {
		throw new DatabaseSchemaMismatchError(sqlitePath, unknownTable);
	}
	for (const table of ALL_TABLES) {
		if (!migratingTables.has(getTableName(table))) {
			assertCompatibleTableSchema(sqlite, table, sqlitePath);
		}
	}

	const actualIndexes = existingSchemaObjects(sqlite, "index");
	const expectedIndexes = new Map<string, string>();
	const migratingIndexNames = new Set<string>(migratingLegacyIndexes);
	for (const table of ALL_TABLES) {
		if (migratingTables.has(getTableName(table))) {
			for (const statement of generateCreateIndexDDL(table)) {
				const name = /index if not exists ([^ ]+)/i.exec(statement)?.[1];
				if (name) migratingIndexNames.add(name);
			}
			continue;
		}
		for (const statement of generateCreateIndexDDL(table)) {
			const name = /index if not exists ([^ ]+)/i.exec(statement)?.[1];
			if (!name) throw new Error(`Could not read generated index name: ${statement}`);
			expectedIndexes.set(name, statement);
		}
	}
	const changedIndex = [...new Set([...actualIndexes.keys(), ...expectedIndexes.keys()])].find(
		(name) =>
			!migratingIndexNames.has(name) &&
			normalizeSchemaSql(actualIndexes.get(name) ?? "") !==
				normalizeSchemaSql(expectedIndexes.get(name) ?? ""),
	);
	if (changedIndex) {
		throw new DatabaseSchemaMismatchError(sqlitePath, `index:${changedIndex}`);
	}
}

const PROCESS_QUESTION_REQUESTS_WITH_DRAFT_STATE_SQL = `CREATE TABLE process_question_requests (
	id text PRIMARY KEY NOT NULL,
	instance_id text NOT NULL REFERENCES process_instances(id) ON DELETE CASCADE,
	turn_record_id text NOT NULL,
	worker_lease_id text NOT NULL,
	tool_call_id text NOT NULL,
	questions_json text NOT NULL,
	draft_json text NOT NULL,
	draft_revision integer NOT NULL DEFAULT 0,
	status text NOT NULL DEFAULT 'open',
	answers_json text,
	asked_at text NOT NULL,
	answered_at text,
	answered_by_json text,
	cancelled_at text,
	CONSTRAINT question_requests_revision CHECK ("process_question_requests"."draft_revision" >= 0),
	CONSTRAINT question_requests_status CHECK ("process_question_requests"."status" in ('open', 'answered', 'cancelled')),
	CONSTRAINT question_requests_questions_json CHECK (json_valid("process_question_requests"."questions_json")),
	CONSTRAINT question_requests_draft_json CHECK (json_valid("process_question_requests"."draft_json")),
	CONSTRAINT question_requests_answers_json CHECK ("process_question_requests"."answers_json" is null or json_valid("process_question_requests"."answers_json")),
	CONSTRAINT fk_question_requests_turn FOREIGN KEY (instance_id, turn_record_id) REFERENCES turn_records(instance_id, id),
	CONSTRAINT fk_question_requests_lease FOREIGN KEY (instance_id, worker_lease_id) REFERENCES worker_leases(instance_id, id)
)`;

const PROVIDER_CREDENTIALS_WITH_SCHEMA_VERSION_SQL = `CREATE TABLE provider_credentials (
	provider_id text PRIMARY KEY NOT NULL,
	credential_schema_version integer NOT NULL,
	revision integer NOT NULL,
	encrypted_payload text NOT NULL,
	created_at text NOT NULL,
	updated_at text NOT NULL,
	CONSTRAINT provider_credentials_positive_revision CHECK ("provider_credentials"."revision" > 0),
	CONSTRAINT provider_credentials_positive_schema_version CHECK ("provider_credentials"."credential_schema_version" > 0)
)`;

function assertMigrationSource(
	sqlite: DatabaseSync,
	sqlitePath: string,
	tableName: string,
	expectedSql: string,
	expectedIndexes: readonly string[],
): void {
	if (
		normalizeCreateTableSql(existingTableSql(sqlite, tableName) ?? "") !==
		normalizeCreateTableSql(expectedSql)
	) {
		throw new DatabaseSchemaMismatchError(sqlitePath, tableName);
	}
	const actualIndexes = sqlite
		.prepare(
			"SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL",
		)
		.all(tableName) as Array<{ sql: string }>;
	if (
		actualIndexes.length !== expectedIndexes.length ||
		actualIndexes.some(
			(actual) =>
				!expectedIndexes.some(
					(expected) => normalizeSchemaSql(actual.sql) === normalizeSchemaSql(expected),
				),
		)
	) {
		throw new DatabaseSchemaMismatchError(sqlitePath, `indexes:${tableName}`);
	}
	if (
		sqlite
			.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?")
			.get(tableName)
	) {
		throw new DatabaseSchemaMismatchError(sqlitePath, `triggers:${tableName}`);
	}
}

const SESSION_TRANSFER_ATTEMPTS_WITH_PROGRESS_SQL = `CREATE TABLE session_transfer_attempts (
	id text PRIMARY KEY NOT NULL,
	grant_id text NOT NULL REFERENCES session_transfer_grants(id) ON DELETE CASCADE,
	instance_id text NOT NULL REFERENCES process_instances(id) ON DELETE CASCADE,
	state text NOT NULL,
	phase text NOT NULL,
	created_at text NOT NULL,
	lease_until text NOT NULL,
	hard_deadline text NOT NULL,
	entries_total integer,
	entries_processed integer NOT NULL DEFAULT 0,
	logical_bytes_total integer,
	logical_bytes_processed integer NOT NULL DEFAULT 0,
	compressed_bytes integer,
	stream_sha256 text,
	failure_code text,
	completed_at text,
	CONSTRAINT session_transfer_attempts_state CHECK ("session_transfer_attempts"."state" in ('queued', 'exporting', 'awaiting_ack', 'cancelled', 'failed', 'consumed'))
)`;

interface KnownMigration {
	id: string;
	tableNames: readonly string[];
	legacyIndexNames?: readonly string[];
	matches(sqlite: DatabaseSync): boolean;
	validateSource?(sqlite: DatabaseSync, sqlitePath: string): void;
	apply(sqlite: DatabaseSync): void;
}

const KNOWN_MIGRATIONS: readonly KnownMigration[] = [
	{
		id: "20260823_add_ticket_destination_recents",
		tableNames: ["ticket_destination_recents"],
		matches: (sqlite) =>
			hasExistingSchema(sqlite) && existingTableSql(sqlite, "ticket_destination_recents") === null,
		apply(sqlite) {
			createTableWithIndexes(sqlite, schema.ticketDestinationRecents);
		},
	},
	{
		id: "20260908_add_api_tokens",
		tableNames: ["api_tokens"],
		matches: (sqlite) =>
			existingTableSql(sqlite, "auth_sessions") !== null &&
			existingTableSql(sqlite, "api_tokens") === null,
		apply: (sqlite) => createTableWithIndexes(sqlite, schema.apiTokens),
	},
	{
		id: "20260901_add_session_transfers",
		tableNames: ["session_transfer_grants", "session_transfer_attempts"],
		matches: (sqlite) =>
			hasExistingSchema(sqlite) &&
			(existingTableSql(sqlite, "session_transfer_grants") === null ||
				existingTableSql(sqlite, "session_transfer_attempts") === null),
		apply(sqlite) {
			if (existingTableSql(sqlite, "session_transfer_grants") === null) {
				createTableWithIndexes(sqlite, schema.sessionTransferGrants);
			}
			if (existingTableSql(sqlite, "session_transfer_attempts") === null) {
				createTableWithIndexes(sqlite, schema.sessionTransferAttempts);
			}
		},
	},
	{
		id: "20260902_session_transfer_phase_state_and_progress",
		tableNames: ["session_transfer_attempts"],
		matches: (sqlite) =>
			existingTableSql(sqlite, "session_transfer_attempts") !== null &&
			(tableHasColumn(sqlite, "session_transfer_attempts", "state") ||
				tableHasColumn(sqlite, "session_transfer_attempts", "entries_processed") ||
				tableHasColumn(sqlite, "session_transfer_attempts", "logical_bytes_processed")),
		validateSource(sqlite, sqlitePath) {
			const legacyIndexes = generateCreateIndexDDL(schema.sessionTransferAttempts).map(
				(statement) =>
					statement.includes("uq_session_transfer_active_instance")
						? `CREATE UNIQUE INDEX uq_session_transfer_active_instance ON session_transfer_attempts(instance_id) WHERE "session_transfer_attempts"."state" in ('queued', 'exporting', 'awaiting_ack')`
						: statement,
			);
			assertMigrationSource(
				sqlite,
				sqlitePath,
				"session_transfer_attempts",
				SESSION_TRANSFER_ATTEMPTS_WITH_PROGRESS_SQL,
				legacyIndexes,
			);
		},
		apply(sqlite) {
			for (const index of [
				"uq_session_transfer_active_instance",
				"idx_session_transfer_attempts_grant",
				"idx_session_transfer_attempts_instance",
				"idx_session_transfer_attempts_deadlines",
			]) {
				sqlite.exec(`DROP INDEX IF EXISTS ${index}`);
			}
			sqlite.exec(
				"ALTER TABLE session_transfer_attempts RENAME TO session_transfer_attempts_legacy",
			);
			createTableWithIndexes(sqlite, schema.sessionTransferAttempts);
			sqlite.exec(`
				INSERT INTO session_transfer_attempts (
					id, grant_id, instance_id, phase, created_at, lease_until, hard_deadline,
					entries_total, logical_bytes_total, compressed_bytes, stream_sha256,
					failure_code, completed_at
				)
				SELECT id, grant_id, instance_id, phase, created_at, lease_until, hard_deadline,
					entries_total, logical_bytes_total, compressed_bytes, stream_sha256,
					failure_code, completed_at
				FROM session_transfer_attempts_legacy
			`);
			sqlite.exec("DROP TABLE session_transfer_attempts_legacy");
		},
	},
	{
		id: "20260827_add_worker_startup_observations",
		tableNames: ["worker_leases"],
		matches: (sqlite) =>
			existingTableSql(sqlite, "worker_leases") !== null &&
			(!tableHasColumn(sqlite, "worker_leases", "turn_start_record_id") ||
				!tableHasColumn(sqlite, "worker_leases", "connected_at") ||
				!tableHasColumn(sqlite, "worker_leases", "workspace_preparation_started_at") ||
				!tableHasColumn(sqlite, "worker_leases", "ready_at")),
		apply(sqlite) {
			if (!tableHasColumn(sqlite, "worker_leases", "turn_start_record_id")) {
				sqlite.exec(
					"ALTER TABLE worker_leases ADD COLUMN turn_start_record_id text REFERENCES turn_start_records(id)",
				);
			}
			if (!tableHasColumn(sqlite, "worker_leases", "connected_at")) {
				sqlite.exec("ALTER TABLE worker_leases ADD COLUMN connected_at text");
			}
			if (!tableHasColumn(sqlite, "worker_leases", "workspace_preparation_started_at")) {
				sqlite.exec("ALTER TABLE worker_leases ADD COLUMN workspace_preparation_started_at text");
			}
			if (!tableHasColumn(sqlite, "worker_leases", "ready_at")) {
				sqlite.exec("ALTER TABLE worker_leases ADD COLUMN ready_at text");
			}
			sqlite.exec(
				"CREATE INDEX IF NOT EXISTS idx_worker_leases_turn_start ON worker_leases(turn_start_record_id)",
			);
		},
	},
	{
		id: "20260826_add_launch_runs",
		tableNames: ["launch_runs", "launch_run_replays", "process_title_jobs"],
		matches: (sqlite) =>
			hasExistingSchema(sqlite) &&
			(existingTableSql(sqlite, "launch_runs") === null ||
				existingTableSql(sqlite, "launch_run_replays") === null ||
				!tableHasColumn(sqlite, "process_title_jobs", "launch_run_id")),
		apply(sqlite) {
			if (existingTableSql(sqlite, "launch_runs") === null) {
				createTableWithIndexes(sqlite, schema.launchRuns);
			}
			if (existingTableSql(sqlite, "launch_run_replays") === null) {
				createTableWithIndexes(sqlite, schema.launchRunReplays);
			}
			if (!tableHasColumn(sqlite, "process_title_jobs", "launch_run_id")) {
				sqlite.exec(
					"ALTER TABLE process_title_jobs ADD COLUMN launch_run_id text REFERENCES launch_runs(id) ON DELETE SET NULL",
				);
			}
			sqlite.exec(
				"CREATE INDEX IF NOT EXISTS idx_process_title_jobs_launch_run ON process_title_jobs(launch_run_id)",
			);
		},
	},
	{
		id: "20260823_add_ticket_approval_destination",
		tableNames: ["process_tool_approval_requests"],
		matches: (sqlite) =>
			existingTableSql(sqlite, "process_tool_approval_requests") !== null &&
			!tableHasColumn(sqlite, "process_tool_approval_requests", "destination_json"),
		apply(sqlite) {
			sqlite.exec("ALTER TABLE process_tool_approval_requests ADD COLUMN destination_json text");
		},
	},
	{
		id: "20260727_remove_process_question_draft_state",
		tableNames: ["process_question_requests"],
		legacyIndexNames: ["idx_question_requests_turn"],
		matches: (sqlite) =>
			normalizeCreateTableSql(existingTableSql(sqlite, "process_question_requests") ?? "") ===
			normalizeCreateTableSql(PROCESS_QUESTION_REQUESTS_WITH_DRAFT_STATE_SQL),
		apply(sqlite) {
			sqlite.exec(
				"ALTER TABLE process_question_requests RENAME TO process_question_requests_before_20260727",
			);
			sqlite.exec(createTableSql(schema.processQuestionRequests));
			sqlite.exec(`INSERT INTO process_question_requests
				(id, instance_id, turn_record_id, tool_call_id, questions_json, status,
				 answers_json, asked_at, answered_at, answered_by_json, cancelled_at)
			SELECT id, instance_id, turn_record_id, tool_call_id, questions_json, status,
				answers_json, asked_at, answered_at, answered_by_json, cancelled_at
			FROM process_question_requests_before_20260727`);
			sqlite.exec("DROP TABLE process_question_requests_before_20260727");
			for (const statement of generateCreateIndexDDL(schema.processQuestionRequests)) {
				sqlite.exec(statement);
			}
		},
	},
	{
		id: "20260726_add_sql_backed_skills",
		tableNames: ["skills", "skill_revisions", "process_skills"],
		matches: (sqlite) =>
			existingTableSql(sqlite, "process_instances") !== null &&
			existingTableSql(sqlite, "skills") === null,
		apply(sqlite) {
			for (const table of [schema.skills, schema.skillRevisions, schema.processSkills]) {
				createTableWithIndexes(sqlite, table);
			}
		},
	},
	{
		id: "20260728_add_skill_catalog_and_invocations",
		tableNames: ["skills", "skill_catalog_entries", "skill_invocations"],
		matches: (sqlite) =>
			existingTableSql(sqlite, "skills") === null ||
			!tableHasColumn(sqlite, "skills", "registration_kind") ||
			existingTableSql(sqlite, "skill_catalog_entries") === null ||
			!tableHasColumn(sqlite, "skill_catalog_entries", "available") ||
			tableHasColumn(sqlite, "skill_catalog_entries", "skill_markdown") ||
			existingTableSql(sqlite, "skill_invocations") === null,
		apply(sqlite) {
			if (!tableHasColumn(sqlite, "skills", "registration_kind")) {
				sqlite.exec(
					"ALTER TABLE skills ADD COLUMN registration_kind text NOT NULL DEFAULT 'configuration'",
				);
			}
			if (existingTableSql(sqlite, "skill_catalog_entries") === null) {
				createTableWithIndexes(sqlite, schema.skillCatalogEntries);
			} else {
				if (!tableHasColumn(sqlite, "skill_catalog_entries", "available")) {
					sqlite.exec(
						"ALTER TABLE skill_catalog_entries ADD COLUMN available integer NOT NULL DEFAULT true",
					);
				}
				if (tableHasColumn(sqlite, "skill_catalog_entries", "skill_markdown")) {
					sqlite.exec("ALTER TABLE skill_catalog_entries DROP COLUMN skill_markdown");
				}
			}
			if (existingTableSql(sqlite, "skill_invocations") === null) {
				createTableWithIndexes(sqlite, schema.skillInvocations);
			}
		},
	},
	{
		id: "20260729_add_skill_revision_dependencies",
		tableNames: ["skill_revision_dependencies"],
		matches: (sqlite) => existingTableSql(sqlite, "skill_revision_dependencies") === null,
		apply(sqlite) {
			createTableWithIndexes(sqlite, schema.skillRevisionDependencies);
		},
	},
	{
		id: "20260726_add_process_question_requests",
		tableNames: ["process_question_requests"],
		matches: (sqlite) => existingTableSql(sqlite, "process_question_requests") === null,
		apply(sqlite) {
			createTableWithIndexes(sqlite, schema.processQuestionRequests);
		},
	},
	{
		id: "20260725_add_model_policy_provenance_and_future_blocks",
		tableNames: ["process_instances", "future_executions", "turn_records"],
		matches: (sqlite) =>
			!tableHasColumn(sqlite, "process_instances", "selected_turn_model_kind") &&
			!tableHasColumn(sqlite, "future_executions", "model_profile_id") &&
			!tableHasColumn(sqlite, "turn_records", "model_selection_kind"),
		apply(sqlite) {
			sqlite.exec(`
				ALTER TABLE process_instances ADD COLUMN selected_turn_model_kind text;
				ALTER TABLE future_executions ADD COLUMN model_profile_id text;
				ALTER TABLE future_executions ADD COLUMN model_selection_kind text;
				ALTER TABLE future_executions ADD COLUMN model_selection_source text;
				ALTER TABLE future_executions ADD COLUMN blocked_reason_json text;
				ALTER TABLE turn_records ADD COLUMN model_selection_kind text;
				ALTER TABLE turn_records ADD COLUMN model_selection_source text;
				UPDATE process_instances SET
					selected_turn_model_kind = CASE
						WHEN selected_turn_model_profile_id IS NULL THEN NULL
						WHEN selected_turn_model_source IN ('action_override','instance_turn_config','instance_default') THEN 'explicit'
						ELSE 'inherited' END,
					selected_turn_model_source = CASE
						WHEN selected_turn_model_profile_id IS NOT NULL AND (selected_turn_model_source IS NULL OR selected_turn_model_source NOT IN ('action_override','instance_turn_config','process_config_turn','instance_default','process_config_default','catalog_default')) THEN 'legacy_persisted'
						ELSE selected_turn_model_source END;
				UPDATE turn_records SET model_selection_kind = 'inherited', model_selection_source = 'legacy_persisted'
					WHERE model_profile_id IS NOT NULL;
			`);
		},
	},
	{
		id: "20260730_add_process_launch_intent",
		tableNames: ["process_instances", "process_launch_intents"],
		matches: (sqlite) =>
			!tableHasColumn(sqlite, "process_instances", "launch_intent_json") ||
			existingTableSql(sqlite, "process_launch_intents") !== null,
		apply(sqlite) {
			if (!tableHasColumn(sqlite, "process_instances", "launch_intent_json")) {
				sqlite.exec("ALTER TABLE process_instances ADD COLUMN launch_intent_json text");
			}
			if (existingTableSql(sqlite, "process_launch_intents") !== null) {
				sqlite.exec(`
					UPDATE process_instances
					SET launch_intent_json = (
						SELECT json_object(
							'launcherId', launcher_id,
							'launcherInput', json(launcher_input_json),
							'selectedSkillIds', json(selected_skill_ids_json)
						)
						FROM process_launch_intents
						WHERE instance_id = process_instances.id
					)
					WHERE launch_intent_json IS NULL
						AND id IN (SELECT instance_id FROM process_launch_intents);
					DROP TABLE process_launch_intents;
				`);
			}
		},
	},
	{
		id: "20260725_add_process_relations_and_tool_approvals",
		tableNames: ["process_relations", "process_tool_approval_requests"],
		matches: (sqlite) =>
			hasExistingSchema(sqlite) &&
			(existingTableSql(sqlite, "process_relations") === null ||
				existingTableSql(sqlite, "process_tool_approval_requests") === null),
		apply(sqlite) {
			if (existingTableSql(sqlite, "process_relations") === null) {
				createTableWithIndexes(sqlite, schema.processRelations);
			}
			if (existingTableSql(sqlite, "process_tool_approval_requests") === null) {
				createTableWithIndexes(sqlite, schema.processToolApprovalRequests);
			}
		},
	},
	{
		id: "20260724_remove_provider_credential_schema_version",
		tableNames: ["provider_credentials"],
		matches: (sqlite) =>
			normalizeCreateTableSql(existingTableSql(sqlite, "provider_credentials") ?? "") ===
			normalizeCreateTableSql(PROVIDER_CREDENTIALS_WITH_SCHEMA_VERSION_SQL),
		apply(sqlite) {
			sqlite.exec(
				"ALTER TABLE provider_credentials RENAME TO provider_credentials_before_20260724",
			);
			sqlite.exec(createTableSql(schema.providerCredentials));
			sqlite.exec(`INSERT INTO provider_credentials
				(provider_id, revision, encrypted_payload, created_at, updated_at)
			SELECT provider_id, revision, encrypted_payload, created_at, updated_at
			FROM provider_credentials_before_20260724`);
			sqlite.exec("DROP TABLE provider_credentials_before_20260724");
		},
	},
	{
		id: "20260821_remove_server_automatic_execution",
		tableNames: ["process_instances", "turn_records"],
		matches: (sqlite) =>
			tableHasColumn(sqlite, "process_instances", "current_server_turn_record_id") ||
			(existingTableSql(sqlite, "turn_records") ?? "").includes("server_automatic"),
		validateSource(sqlite, sqlitePath) {
			// Earlier migrations restore model provenance and launch-intent columns first.
			// Validate the complete source before rebuilding either table loses its DDL.
			const legacyProcessSql = createTableSql(schema.processInstances)
				.replace("(\n", "(\ncurrent_server_turn_record_id text,\n")
				.replace(
					/\n\)$/,
					`,
				CONSTRAINT process_instances_one_current_execution CHECK (not ("process_instances"."current_worker_start_id" is not null and "process_instances"."current_server_turn_record_id" is not null)),
				CONSTRAINT fk_process_instances_server_turn FOREIGN KEY (id, current_server_turn_record_id) REFERENCES turn_records(instance_id, id)
				)`,
				);
			const legacyTurnSql = createTableSql(schema.turnRecords).replace(
				"in ('llm', 'human', 'external', 'automatic')",
				"in ('llm', 'human', 'external', 'automatic', 'server_automatic')",
			);
			for (const [table, expectedSql] of [
				[schema.processInstances, legacyProcessSql],
				[schema.turnRecords, legacyTurnSql],
			] as const) {
				assertMigrationSource(
					sqlite,
					sqlitePath,
					getTableName(table),
					expectedSql,
					generateCreateIndexDDL(table),
				);
			}
		},
		apply(sqlite) {
			const endedAt = new Date().toISOString();
			sqlite
				.prepare(`UPDATE turn_records
					SET status = 'failed',
						error_summary = coalesce(error_summary, 'Server-automatic execution was removed'),
						ended_at = coalesce(ended_at, ?)
					WHERE turn_type = 'server_automatic' AND status = 'running'`)
				.run(endedAt);
			sqlite
				.prepare(`UPDATE process_instances
					SET lifecycle_status = 'aborted',
						closed_at = coalesce(closed_at, ?),
						updated_at = ?
					WHERE current_server_turn_record_id IS NOT NULL`)
				.run(endedAt, endedAt);
			sqlite
				.prepare(`INSERT INTO worker_leases
					(id, instance_id, worker_id, state, started_at, exited_at)
				SELECT 'wkr_migrated_20260821_' || id, instance_id,
					'server-automatic-migration:' || id, 'exited', started_at, coalesce(ended_at, ?)
				FROM turn_records WHERE turn_type = 'server_automatic'`)
				.run(endedAt);
			sqlite
				.prepare(`INSERT INTO turn_start_records
					(id, instance_id, turn_id, turn_type, proposed_turn_record_id, start_kind,
					 state_json, created_at, updated_at)
				SELECT 'tsr_migrated_20260821_' || id, instance_id, turn_id, 'automatic', id,
					'selected_turn',
					json_object(
						'kind', 'accepted',
						'start', json_object('kind', 'automatic'),
						'turnRecordId', id,
						'acceptedWorkerLeaseId', 'wkr_migrated_20260821_' || id,
						'acceptedAt', coalesce(ended_at, ?)
					),
					started_at, coalesce(ended_at, ?)
				FROM turn_records WHERE turn_type = 'server_automatic'`)
				.run(endedAt, endedAt);
			const stagedProcesses = "staged_process_instances_20260821";
			const stagedTurns = "staged_turn_records_20260821";
			sqlite.exec(`
				CREATE TEMP TABLE ${stagedProcesses} AS
				SELECT id, process_id, selected_turn_id, lifecycle_status, current_worker_start_id,
					plan_revision, title, external_id, external_url, metadata, default_model_profile_id,
					turn_configs_json, selected_turn_model_profile_id, params_json, state_json,
					created_at, updated_at, closed_at, initial_default_model_profile_id,
					selected_turn_model_source, selected_turn_model_kind, launch_intent_json
				FROM process_instances;

				CREATE TEMP TABLE ${stagedTurns} AS
				SELECT id, instance_id, turn_id,
					CASE turn_type WHEN 'server_automatic' THEN 'automatic' ELSE turn_type END AS turn_type,
					status, attempt_number, parent_turn_record_id,
					CASE turn_type
						WHEN 'server_automatic' THEN 'tsr_migrated_20260821_' || id
						ELSE turn_start_record_id
					END AS turn_start_record_id,
					CASE turn_type
						WHEN 'server_automatic' THEN 'wkr_migrated_20260821_' || id
						ELSE accepted_worker_lease_id
					END AS accepted_worker_lease_id,
					path_type, fork_pi_entry_id, result_pi_entry_id,
					model_profile_id, turn_result_markdown, error_summary, error_class, started_at,
					ended_at, model_selection_kind, model_selection_source
				FROM turn_records;

				DROP TABLE turn_records;
				DROP TABLE process_instances;
			`);
			sqlite.exec(createTableSql(schema.processInstances));
			sqlite.exec(createTableSql(schema.turnRecords));
			sqlite.exec(`
				INSERT INTO process_instances (
					id, process_id, selected_turn_id, lifecycle_status, current_worker_start_id,
					plan_revision, title, external_id, external_url, metadata, default_model_profile_id,
					turn_configs_json, selected_turn_model_profile_id, params_json, state_json,
					created_at, updated_at, closed_at, initial_default_model_profile_id,
					selected_turn_model_source, selected_turn_model_kind, launch_intent_json
				)
				SELECT * FROM ${stagedProcesses};

				INSERT INTO turn_records (
					id, instance_id, turn_id, turn_type, status, attempt_number, parent_turn_record_id,
					turn_start_record_id, accepted_worker_lease_id, path_type, fork_pi_entry_id,
					result_pi_entry_id, model_profile_id, turn_result_markdown, error_summary,
					error_class, started_at, ended_at, model_selection_kind, model_selection_source
				)
				SELECT * FROM ${stagedTurns};
				DROP TABLE ${stagedProcesses};
				DROP TABLE ${stagedTurns};
			`);
			for (const table of [schema.processInstances, schema.turnRecords]) {
				for (const statement of generateCreateIndexDDL(table)) sqlite.exec(statement);
			}
		},
	},
];

function backupSqliteFiles(sqlite: DatabaseSync, sqlitePath: string): string {
	const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
	const backupDir = join(dirname(sqlitePath), "backups");
	mkdirSync(backupDir, { recursive: true });
	const backupBasePath = join(backupDir, `${basename(sqlitePath)}.${stamp}.bak`);

	// Fold committed WAL pages into the main file before taking the startup copy.
	sqlite.prepare("PRAGMA wal_checkpoint(TRUNCATE)").all();
	for (const suffix of ["", "-wal", "-shm"]) {
		const source = `${sqlitePath}${suffix}`;
		if (existsSync(source)) copyFileSync(source, `${backupBasePath}${suffix}`);
	}
	return backupBasePath;
}

export interface AppliedMigrationSummary {
	backupPath: string;
	migrationIds: string[];
}

export function applyKnownMigrations(
	sqlite: DatabaseSync,
	sqlitePath: string,
): AppliedMigrationSummary | null {
	const migrations = KNOWN_MIGRATIONS.filter((migration) => migration.matches(sqlite));
	if (migrations.length === 0) return null;

	const migratingTables = new Set(migrations.flatMap((migration) => migration.tableNames));
	const migratingLegacyIndexes = new Set(
		migrations.flatMap((migration) => migration.legacyIndexNames ?? []),
	);
	assertBaselineSchema(sqlite, sqlitePath, migratingTables, migratingLegacyIndexes);
	const backupPath = backupSqliteFiles(sqlite, sqlitePath);
	sqlite.exec("PRAGMA foreign_keys = OFF");
	try {
		sqlite.exec("BEGIN");
		try {
			for (const migration of migrations) {
				migration.validateSource?.(sqlite, sqlitePath);
				migration.apply(sqlite);
			}
			assertBaselineSchema(sqlite, sqlitePath);
			const violations = sqlite.prepare("PRAGMA foreign_key_check").all();
			if (violations.length > 0) {
				throw new Error(`SQLite migration produced ${violations.length} foreign-key violation(s)`);
			}
			sqlite.exec("COMMIT");
		} catch (error) {
			sqlite.exec("ROLLBACK");
			throw error;
		}
	} finally {
		sqlite.exec("PRAGMA foreign_keys = ON");
	}
	return { backupPath, migrationIds: migrations.map((migration) => migration.id) };
}

export function initializeSchema(sqlite: DatabaseSync, opts: InitializeSchemaOptions = {}) {
	const sqlitePath = opts.sqlitePath ?? ":memory:";
	for (const table of ALL_TABLES) {
		createTableWithIndexes(sqlite, table);
		assertCompatibleTableSchema(sqlite, table, sqlitePath);
	}
}

export function createDatabase(opts: DatabaseOptions) {
	const fileBacked = opts.sqlitePath !== ":memory:";
	const existingFileBackedDatabase = fileBacked && existsSync(opts.sqlitePath);
	if (fileBacked) {
		mkdirSync(dirname(opts.sqlitePath), { recursive: true });
	}

	const sqlite = new DatabaseSync(opts.sqlitePath, { timeout: 5_000 });
	try {
		if (opts.enableWAL !== false) {
			sqlite.prepare("PRAGMA journal_mode = WAL").get();
		}
		sqlite.exec("PRAGMA foreign_keys = ON");

		if (existingFileBackedDatabase && hasExistingSchema(sqlite)) {
			const applied = applyKnownMigrations(sqlite, opts.sqlitePath);
			if (applied) {
				console.info(
					`[database] Applied SQLite migration(s): ${applied.migrationIds.join(", ")}. Backup: ${applied.backupPath}`,
				);
			}
			assertBaselineSchema(sqlite, opts.sqlitePath);
		} else {
			initializeSchema(sqlite, { sqlitePath: opts.sqlitePath });
		}
		return drizzle({ client: sqlite });
	} catch (error) {
		sqlite.close();
		throw error;
	}
}

export function createInMemoryDatabase() {
	return createDatabase({ sqlitePath: ":memory:", enableWAL: false });
}

export function closeDatabase(db: LeitwerkDb): void {
	const sqlite = (db as unknown as { $client?: DatabaseSync }).$client;
	sqlite?.close();
}
