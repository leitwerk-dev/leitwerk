import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import * as schema from "./schema.js";
import { generateCreateIndexDDL, generateCreateTableDDL, getTableName } from "./schema-ddl.js";

export type LeitwerkDb = ReturnType<typeof drizzle<typeof schema>>;

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
	schema.providerCredentials,
	schema.externalWriteLog,
] as const;

function createTableSql(table: SQLiteTable): string {
	return generateCreateTableDDL(
		table,
		schema.BASELINE_TABLE_CONSTRAINTS[getTableName(table)] ?? [],
	);
}

function createTableWithIndexes(sqlite: Database.Database, table: SQLiteTable): void {
	sqlite.exec(createTableSql(table));
	for (const statement of generateCreateIndexDDL(table)) sqlite.exec(statement);
}

function existingTableSql(sqlite: Database.Database, tableName: string): string | null {
	const row = sqlite
		.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
		.get(tableName) as { sql?: string | null } | undefined;
	return typeof row?.sql === "string" ? row.sql : null;
}

function tableHasColumn(sqlite: Database.Database, tableName: string, columnName: string): boolean {
	return (sqlite.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>).some(
		(column) => column.name === columnName,
	);
}

function existingSchemaObjects(
	sqlite: Database.Database,
	type: "table" | "index",
): Map<string, string> {
	const rows = sqlite
		.prepare(
			"SELECT name, sql FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name",
		)
		.all(type) as Array<{ name: string; sql: string | null }>;
	return new Map(rows.flatMap((row) => (row.sql ? [[row.name, row.sql] as const] : [])));
}

function hasExistingSchema(sqlite: Database.Database): boolean {
	const row = sqlite
		.prepare(
			"SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
		)
		.get() as { count: number };
	return row.count > 0;
}

function normalizeCreateTableSql(sql: string): string {
	return sql
		.toLowerCase()
		.replace(/create\s+table\s+if\s+not\s+exists/g, "create table")
		.replace(/\s+/g, "")
		.trim();
}

function normalizeSchemaSql(sql: string): string {
	return normalizeCreateTableSql(sql).replace(/create(unique)?indexifnotexists/g, "create$1index");
}

function assertCompatibleTableSchema(
	sqlite: Database.Database,
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
	sqlite: Database.Database,
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

const PROCESS_INSTANCES_BEFORE_MODEL_POLICY_SQL = `CREATE TABLE process_instances (
	id text PRIMARY KEY NOT NULL, process_id text NOT NULL, selected_turn_id text,
	lifecycle_status text NOT NULL DEFAULT 'discovered', current_worker_start_id text,
	current_server_turn_record_id text, plan_revision integer NOT NULL DEFAULT 0, title text,
	external_id text, external_url text, metadata text, default_model_profile_id text,
	turn_configs_json text, selected_turn_model_profile_id text, params_json text, state_json text,
	created_at text NOT NULL, updated_at text NOT NULL, closed_at text,
	initial_default_model_profile_id text, selected_turn_model_source text,
	CONSTRAINT process_instances_one_current_execution CHECK (not ("process_instances"."current_worker_start_id" is not null and "process_instances"."current_server_turn_record_id" is not null)),
	CONSTRAINT fk_process_instances_worker_start FOREIGN KEY (id, current_worker_start_id) REFERENCES turn_start_records(instance_id, id),
	CONSTRAINT fk_process_instances_server_turn FOREIGN KEY (id, current_server_turn_record_id) REFERENCES turn_records(instance_id, id)
)`;

const FUTURE_EXECUTIONS_BEFORE_MODEL_POLICY_SQL = `CREATE TABLE future_executions (
	id text PRIMARY KEY NOT NULL, kind text NOT NULL, schedule_kind text NOT NULL,
	process_id text NOT NULL, instance_id text REFERENCES process_instances(id) ON DELETE CASCADE,
	launcher_id text, action_id text, payload_json text NOT NULL, cron_expression text,
	next_run_at text NOT NULL, created_at text NOT NULL, updated_at text NOT NULL
)`;

const TURN_RECORDS_BEFORE_MODEL_POLICY_SQL = `CREATE TABLE turn_records (
	id text PRIMARY KEY NOT NULL, instance_id text NOT NULL REFERENCES process_instances(id) ON DELETE CASCADE,
	turn_id text NOT NULL, turn_type text NOT NULL DEFAULT 'llm', status text NOT NULL,
	attempt_number integer NOT NULL DEFAULT 1, parent_turn_record_id text, turn_start_record_id text,
	accepted_worker_lease_id text, path_type text NOT NULL DEFAULT 'primary', fork_pi_entry_id text,
	result_pi_entry_id text, model_profile_id text, turn_result_markdown text, error_summary text,
	error_class text, started_at text NOT NULL, ended_at text,
	CONSTRAINT turn_records_worker_start_link CHECK ((("turn_records"."turn_type" in ('llm', 'automatic')) and "turn_records"."turn_start_record_id" is not null and "turn_records"."accepted_worker_lease_id" is not null) or (("turn_records"."turn_type" not in ('llm', 'automatic')) and "turn_records"."turn_start_record_id" is null and "turn_records"."accepted_worker_lease_id" is null)),
	CONSTRAINT turn_records_type CHECK ("turn_records"."turn_type" in ('llm', 'human', 'external', 'automatic', 'server_automatic')),
	CONSTRAINT fk_turn_records_accepted_start FOREIGN KEY (turn_start_record_id, instance_id, id, turn_id) REFERENCES turn_start_records(id, instance_id, proposed_turn_record_id, turn_id),
	CONSTRAINT fk_turn_records_accepted_lease FOREIGN KEY (instance_id, accepted_worker_lease_id) REFERENCES worker_leases(instance_id, id),
	CONSTRAINT fk_turn_records_parent FOREIGN KEY (instance_id, parent_turn_record_id) REFERENCES turn_records(instance_id, id)
)`;

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

interface KnownMigration {
	id: string;
	tableNames: readonly string[];
	legacyIndexNames?: readonly string[];
	matches(sqlite: Database.Database): boolean;
	apply(sqlite: Database.Database): void;
}

const KNOWN_MIGRATIONS: readonly KnownMigration[] = [
	{
		id: "20260908_add_api_tokens",
		tableNames: ["api_tokens"],
		matches: (sqlite) =>
			existingTableSql(sqlite, "auth_sessions") !== null &&
			existingTableSql(sqlite, "api_tokens") === null,
		apply: (sqlite) => createTableWithIndexes(sqlite, schema.apiTokens),
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
			normalizeCreateTableSql(existingTableSql(sqlite, "process_instances") ?? "") ===
				normalizeCreateTableSql(PROCESS_INSTANCES_BEFORE_MODEL_POLICY_SQL) &&
			normalizeCreateTableSql(existingTableSql(sqlite, "future_executions") ?? "") ===
				normalizeCreateTableSql(FUTURE_EXECUTIONS_BEFORE_MODEL_POLICY_SQL) &&
			normalizeCreateTableSql(existingTableSql(sqlite, "turn_records") ?? "") ===
				normalizeCreateTableSql(TURN_RECORDS_BEFORE_MODEL_POLICY_SQL),
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
];

function backupSqliteFiles(sqlite: Database.Database, sqlitePath: string): string {
	const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
	const backupDir = join(dirname(sqlitePath), "backups");
	mkdirSync(backupDir, { recursive: true });
	const backupBasePath = join(backupDir, `${basename(sqlitePath)}.${stamp}.bak`);

	// Fold committed WAL pages into the main file before taking the startup copy.
	sqlite.pragma("wal_checkpoint(TRUNCATE)");
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
	sqlite: Database.Database,
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
	sqlite.transaction(() => {
		for (const migration of migrations) migration.apply(sqlite);
		assertBaselineSchema(sqlite, sqlitePath);
	})();
	return { backupPath, migrationIds: migrations.map((migration) => migration.id) };
}

export function initializeSchema(sqlite: Database.Database, opts: InitializeSchemaOptions = {}) {
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

	const sqlite = new Database(opts.sqlitePath);
	try {
		if (opts.enableWAL !== false) {
			sqlite.pragma("journal_mode = WAL");
		}
		sqlite.pragma("foreign_keys = ON");
		sqlite.pragma("busy_timeout = 5000");

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
		return drizzle(sqlite, { schema });
	} catch (error) {
		sqlite.close();
		throw error;
	}
}

export function createInMemoryDatabase() {
	return createDatabase({ sqlitePath: ":memory:", enableWAL: false });
}

export function closeDatabase(db: LeitwerkDb): void {
	const sqlite = (db as unknown as { $client?: Database.Database }).$client;
	sqlite?.close();
}
