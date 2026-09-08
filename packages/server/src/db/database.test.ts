import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	closeDatabase,
	createDatabase,
	DatabaseSchemaMismatchError,
	initializeSchema,
} from "./database.js";

function columnNames(sqlite: DatabaseSync, table: string): string[] {
	return (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
		(row) => row.name,
	);
}

function tableNames(sqlite: DatabaseSync): string[] {
	return (
		sqlite
			.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
			)
			.all() as Array<{ name: string }>
	).map((row) => row.name);
}

function openBaseline(): DatabaseSync {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = ON");
	initializeSchema(sqlite);
	return sqlite;
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

function replaceProviderCredentialsWithPreviousSchema(sqlite: DatabaseSync): void {
	sqlite.exec("DROP TABLE provider_credentials");
	sqlite.exec(PROVIDER_CREDENTIALS_WITH_SCHEMA_VERSION_SQL);
	sqlite
		.prepare(
			`INSERT INTO provider_credentials
				(provider_id, credential_schema_version, revision, encrypted_payload, created_at, updated_at)
			 VALUES ('codex-nifto', 1, 7, 'encrypted-value', '2026-07-23', '2026-07-24')`,
		)
		.run();
}

function insertProcess(sqlite: DatabaseSync, id: string): void {
	sqlite
		.prepare(
			"INSERT INTO process_instances (id, process_id, created_at, updated_at) VALUES (?, 'test_process', '2026-07-22', '2026-07-22')",
		)
		.run(id);
}

function insertLease(sqlite: DatabaseSync, id: string, instanceId: string): void {
	sqlite
		.prepare(
			"INSERT INTO worker_leases (id, instance_id, worker_id, state, started_at) VALUES (?, ?, ?, 'bootstrapping', '2026-07-22')",
		)
		.run(id, instanceId, `worker-${id}`);
}

function insertStart(input: {
	sqlite: DatabaseSync;
	id: string;
	instanceId: string;
	proposedTurnRecordId: string;
	turnId?: string;
}): void {
	input.sqlite
		.prepare(
			`INSERT INTO turn_start_records
				(id, instance_id, turn_id, turn_type, proposed_turn_record_id, start_kind, state_json, created_at, updated_at)
			 VALUES (?, ?, ?, 'llm', ?, 'selected_turn', ?, '2026-07-22', '2026-07-22')`,
		)
		.run(
			input.id,
			input.instanceId,
			input.turnId ?? "generate",
			input.proposedTurnRecordId,
			JSON.stringify({ kind: "starting", start: { kind: "automatic" } }),
		);
}

function insertAcceptedWorkerTurn(input: {
	sqlite: DatabaseSync;
	id: string;
	instanceId: string;
	turnId?: string;
	startRecordId: string;
	leaseId: string;
}): void {
	input.sqlite
		.prepare(
			`INSERT INTO turn_records
				(id, instance_id, turn_id, turn_type, status, turn_start_record_id, accepted_worker_lease_id, started_at)
			 VALUES (?, ?, ?, 'llm', 'running', ?, ?, '2026-07-22')`,
		)
		.run(
			input.id,
			input.instanceId,
			input.turnId ?? "generate",
			input.startRecordId,
			input.leaseId,
		);
}

describe("fresh SQLite baseline", () => {
	it("initializes the redesign tables, pointers, and composite foreign keys", () => {
		const sqlite = openBaseline();
		expect(tableNames(sqlite)).toEqual(
			expect.arrayContaining(["process_instances", "turn_start_records", "provider_credentials"]),
		);
		expect(columnNames(sqlite, "process_instances")).toEqual(
			expect.arrayContaining(["current_worker_start_id"]),
		);
		expect(columnNames(sqlite, "process_instances")).not.toContain("current_server_turn_record_id");
		expect(columnNames(sqlite, "process_instances")).not.toEqual(
			expect.arrayContaining(["current_turn_record_id", "failed_turn_record_id"]),
		);
		const foreignKeys = sqlite.prepare("PRAGMA foreign_key_list(turn_records)").all() as Array<{
			table: string;
			from: string;
			to: string;
		}>;
		expect(foreignKeys).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					table: "turn_start_records",
					from: "turn_start_record_id",
					to: "id",
				}),
				expect.objectContaining({
					table: "worker_leases",
					from: "accepted_worker_lease_id",
					to: "id",
				}),
			]),
		);
		sqlite.close();
	});

	it("reopens an unchanged baseline without rewriting it", () => {
		const tempRoot = mkdtempSync(path.join(tmpdir(), "leitwerk-baseline-"));
		const sqlitePath = path.join(tempRoot, "leitwerk.sqlite");
		closeDatabase(createDatabase({ sqlitePath, enableWAL: false }));
		const reopened = createDatabase({ sqlitePath, enableWAL: false });
		expect(reopened).toBeDefined();
		closeDatabase(reopened);
	});
});

describe("SQL-backed skill migration", () => {
	it("backs up a file-backed database and preserves existing process data", () => {
		const tempRoot = mkdtempSync(path.join(tmpdir(), "leitwerk-skill-migration-"));
		const sqlitePath = path.join(tempRoot, "leitwerk.sqlite");
		const seed = new DatabaseSync(sqlitePath);
		seed.exec("PRAGMA foreign_keys = OFF");
		initializeSchema(seed, { sqlitePath });
		seed.exec(`
			DROP TABLE process_skills;
			DROP TABLE skill_revision_dependencies;
			DROP TABLE skill_revisions;
			DROP TABLE skills;
			INSERT INTO process_instances (id, process_id, created_at, updated_at)
			VALUES ('preserved', 'test_process', '2026-07-25', '2026-07-25');
		`);
		seed.close();

		const db = createDatabase({ sqlitePath, enableWAL: false });
		const sqlite = (db as unknown as { $client: DatabaseSync }).$client;
		expect(tableNames(sqlite)).toEqual(
			expect.arrayContaining([
				"skills",
				"skill_revisions",
				"skill_revision_dependencies",
				"process_skills",
				"skill_catalog_entries",
				"skill_invocations",
			]),
		);
		expect(columnNames(sqlite, "skills")).toContain("registration_kind");
		expect(sqlite.prepare("SELECT id FROM process_instances WHERE id = 'preserved'").get()).toEqual(
			{ id: "preserved" },
		);
		const backupName = readdirSync(path.join(tempRoot, "backups")).find((name) =>
			name.endsWith(".bak"),
		);
		expect(backupName).toBeDefined();
		const backup = new DatabaseSync(path.join(tempRoot, "backups", String(backupName)), {
			readOnly: true,
		});
		expect(tableNames(backup)).not.toContain("skills");
		expect(backup.prepare("SELECT id FROM process_instances WHERE id = 'preserved'").get()).toEqual(
			{ id: "preserved" },
		);
		backup.close();
		closeDatabase(db);
	});

	it("normalizes an already-created development catalog without losing entries", () => {
		const tempRoot = mkdtempSync(path.join(tmpdir(), "leitwerk-catalog-migration-"));
		const sqlitePath = path.join(tempRoot, "leitwerk.sqlite");
		const seed = new DatabaseSync(sqlitePath);
		seed.exec("PRAGMA foreign_keys = OFF");
		initializeSchema(seed, { sqlitePath });
		seed.exec(`
			ALTER TABLE skills DROP COLUMN registration_kind;
			ALTER TABLE skill_catalog_entries ADD COLUMN skill_markdown text NOT NULL DEFAULT '';
			ALTER TABLE skill_catalog_entries DROP COLUMN available;
			INSERT INTO skill_catalog_entries
				(repository_id, skill_id, label, source_path, source_revision, bundle_digest,
				 bundle_bytes, discovered_at, skill_markdown)
			VALUES ('shared', 'review', 'Review', 'skills/review', 'abc', 'digest',
				 X'00', '2026-07-29', '# Review');
		`);
		seed.close();

		const db = createDatabase({ sqlitePath, enableWAL: false });
		const sqlite = (db as unknown as { $client: DatabaseSync }).$client;
		expect(columnNames(sqlite, "skills")).toContain("registration_kind");
		expect(columnNames(sqlite, "skill_catalog_entries")).toContain("available");
		expect(columnNames(sqlite, "skill_catalog_entries")).not.toContain("skill_markdown");
		expect(
			sqlite.prepare("SELECT repository_id, skill_id, available FROM skill_catalog_entries").get(),
		).toEqual({ repository_id: "shared", skill_id: "review", available: 1 });
		closeDatabase(db);
	});
});

describe("process launch intent migration", () => {
	it("backs up a file-backed database and preserves existing processes", () => {
		const tempRoot = mkdtempSync(path.join(tmpdir(), "leitwerk-launch-intent-migration-"));
		const sqlitePath = path.join(tempRoot, "leitwerk.sqlite");
		const seed = new DatabaseSync(sqlitePath);
		seed.exec("PRAGMA foreign_keys = OFF");
		initializeSchema(seed, { sqlitePath });
		seed.exec(`
			ALTER TABLE process_instances DROP COLUMN launch_intent_json;
			CREATE TABLE process_launch_intents (
				instance_id text PRIMARY KEY NOT NULL REFERENCES process_instances(id) ON DELETE CASCADE,
				launcher_id text NOT NULL,
				launcher_input_json text NOT NULL,
				selected_skill_ids_json text NOT NULL
			);
			INSERT INTO process_instances (id, process_id, created_at, updated_at)
			VALUES ('preserved-launch', 'test_process', '2026-07-30', '2026-07-30');
			INSERT INTO process_launch_intents
				(instance_id, launcher_id, launcher_input_json, selected_skill_ids_json)
			VALUES ('preserved-launch', 'test-launcher', '{"repository":"org/repo"}', '["review"]');
		`);
		seed.close();

		const db = createDatabase({ sqlitePath, enableWAL: false });
		const sqlite = (db as unknown as { $client: DatabaseSync }).$client;
		expect(columnNames(sqlite, "process_instances")).toContain("launch_intent_json");
		expect(
			sqlite
				.prepare(
					"SELECT id, launch_intent_json FROM process_instances WHERE id = 'preserved-launch'",
				)
				.get(),
		).toEqual({
			id: "preserved-launch",
			launch_intent_json:
				'{"launcherId":"test-launcher","launcherInput":{"repository":"org/repo"},"selectedSkillIds":["review"]}',
		});
		expect(tableNames(sqlite)).not.toContain("process_launch_intents");
		const backupName = readdirSync(path.join(tempRoot, "backups")).find((name) =>
			name.endsWith(".bak"),
		);
		expect(backupName).toBeDefined();
		const backup = new DatabaseSync(path.join(tempRoot, "backups", String(backupName)), {
			readOnly: true,
		});
		expect(columnNames(backup, "process_instances")).not.toContain("launch_intent_json");
		expect(tableNames(backup)).toContain("process_launch_intents");
		backup.close();
		closeDatabase(db);
	});
});

describe("worker startup observation migration", () => {
	it("backs up a file-backed database and preserves existing leases", () => {
		const tempRoot = mkdtempSync(path.join(tmpdir(), "leitwerk-worker-startup-migration-"));
		const sqlitePath = path.join(tempRoot, "leitwerk.sqlite");
		const seed = new DatabaseSync(sqlitePath);
		seed.exec("PRAGMA foreign_keys = OFF");
		initializeSchema(seed, { sqlitePath });
		seed.exec(`
			INSERT INTO process_instances (id, process_id, created_at, updated_at)
			VALUES ('preserved-worker', 'test_process', '2026-08-27', '2026-08-27');
			INSERT INTO worker_leases (id, instance_id, worker_id, state, started_at)
			VALUES ('wls-preserved', 'preserved-worker', 'worker-preserved', 'bootstrapping', '2026-08-27');
			DROP INDEX idx_worker_leases_turn_start;
			ALTER TABLE worker_leases DROP COLUMN ready_at;
			ALTER TABLE worker_leases DROP COLUMN workspace_preparation_started_at;
			ALTER TABLE worker_leases DROP COLUMN connected_at;
			ALTER TABLE worker_leases DROP COLUMN turn_start_record_id;
		`);
		seed.close();

		const db = createDatabase({ sqlitePath, enableWAL: false });
		const sqlite = (db as unknown as { $client: DatabaseSync }).$client;
		expect(columnNames(sqlite, "worker_leases")).toEqual(
			expect.arrayContaining([
				"turn_start_record_id",
				"connected_at",
				"workspace_preparation_started_at",
				"ready_at",
			]),
		);
		expect(
			sqlite.prepare("SELECT id, worker_id FROM worker_leases WHERE id = 'wls-preserved'").get(),
		).toEqual({ id: "wls-preserved", worker_id: "worker-preserved" });
		const backupName = readdirSync(path.join(tempRoot, "backups")).find((name) =>
			name.endsWith(".bak"),
		);
		expect(backupName).toBeDefined();
		closeDatabase(db);
	});
});

describe("process model policy migration", () => {
	it("backs up and preserves file-backed provenance data", () => {
		const tempRoot = mkdtempSync(path.join(tmpdir(), "leitwerk-model-policy-migration-"));
		const sqlitePath = path.join(tempRoot, "leitwerk.sqlite");
		const seed = new DatabaseSync(sqlitePath);
		seed.exec("PRAGMA foreign_keys = OFF");
		initializeSchema(seed, { sqlitePath });
		seed.exec(`
			ALTER TABLE process_instances DROP COLUMN launch_intent_json;
			ALTER TABLE process_instances DROP COLUMN selected_turn_model_kind;
			ALTER TABLE future_executions DROP COLUMN blocked_reason_json;
			ALTER TABLE future_executions DROP COLUMN model_selection_source;
			ALTER TABLE future_executions DROP COLUMN model_selection_kind;
			ALTER TABLE future_executions DROP COLUMN model_profile_id;
			ALTER TABLE turn_records DROP COLUMN model_selection_source;
			ALTER TABLE turn_records DROP COLUMN model_selection_kind;
			INSERT INTO process_instances
				(id, process_id, selected_turn_model_profile_id, selected_turn_model_source, created_at, updated_at)
			VALUES
				('explicit', 'test_process', 'profile-a', 'instance_default', '2026-07-24', '2026-07-24'),
				('ambiguous', 'test_process', 'profile-b', NULL, '2026-07-24', '2026-07-24');
			INSERT INTO future_executions
				(id, kind, schedule_kind, process_id, payload_json, next_run_at, created_at, updated_at)
			VALUES ('future', 'launch', 'once', 'test_process', '{}', '2026-07-25', '2026-07-24', '2026-07-24');
		`);
		seed.close();

		const db = createDatabase({ sqlitePath, enableWAL: false });
		const sqlite = (db as unknown as { $client: DatabaseSync }).$client;
		expect(
			sqlite
				.prepare(
					"SELECT id, selected_turn_model_kind AS kind, selected_turn_model_source AS source FROM process_instances ORDER BY id",
				)
				.all(),
		).toEqual([
			{ id: "ambiguous", kind: "inherited", source: "legacy_persisted" },
			{ id: "explicit", kind: "explicit", source: "instance_default" },
		]);
		expect(sqlite.prepare("SELECT count(*) AS count FROM future_executions").get()).toEqual({
			count: 1,
		});
		const backupName = readdirSync(path.join(tempRoot, "backups")).find((name) =>
			name.endsWith(".bak"),
		);
		expect(backupName).toBeDefined();
		const backup = new DatabaseSync(path.join(tempRoot, "backups", String(backupName)), {
			readOnly: true,
		});
		expect(columnNames(backup, "process_instances")).not.toContain("selected_turn_model_kind");
		expect(columnNames(backup, "process_instances")).not.toContain("launch_intent_json");
		backup.close();
		closeDatabase(db);
		expect(() => {
			const reopened = createDatabase({ sqlitePath, enableWAL: false });
			closeDatabase(reopened);
		}).not.toThrow();
	});
});

describe("provider credential migration", () => {
	const migrationPath = path.join(
		path.dirname(fileURLToPath(import.meta.url)),
		"../../migrations/20260724_remove_provider_credential_schema_version.sql",
	);

	it("preserves credentials and produces the current schema", () => {
		const sqlite = openBaseline();
		replaceProviderCredentialsWithPreviousSchema(sqlite);

		sqlite.exec(readFileSync(migrationPath, "utf8"));

		expect(() => initializeSchema(sqlite)).not.toThrow();
		expect(columnNames(sqlite, "provider_credentials")).toEqual([
			"provider_id",
			"revision",
			"encrypted_payload",
			"created_at",
			"updated_at",
		]);
		expect(sqlite.prepare("SELECT * FROM provider_credentials").get()).toEqual({
			provider_id: "codex-nifto",
			revision: 7,
			encrypted_payload: "encrypted-value",
			created_at: "2026-07-23",
			updated_at: "2026-07-24",
		});
		sqlite.close();
	});

	it("backs up and automatically migrates the known file-backed schema", () => {
		const tempRoot = mkdtempSync(path.join(tmpdir(), "leitwerk-provider-migration-"));
		const sqlitePath = path.join(tempRoot, "leitwerk.sqlite");
		const seed = new DatabaseSync(sqlitePath);
		seed.exec("PRAGMA foreign_keys = ON");
		initializeSchema(seed, { sqlitePath });
		replaceProviderCredentialsWithPreviousSchema(seed);
		seed.close();

		const db = createDatabase({ sqlitePath, enableWAL: false });
		const sqlite = (db as unknown as { $client: DatabaseSync }).$client;
		expect(columnNames(sqlite, "provider_credentials")).not.toContain("credential_schema_version");
		expect(sqlite.prepare("SELECT encrypted_payload FROM provider_credentials").get()).toEqual({
			encrypted_payload: "encrypted-value",
		});
		const backupName = readdirSync(path.join(tempRoot, "backups")).find((name) =>
			name.endsWith(".bak"),
		);
		expect(backupName).toBeDefined();
		const backup = new DatabaseSync(path.join(tempRoot, "backups", String(backupName)), {
			readOnly: true,
		});
		expect(columnNames(backup, "provider_credentials")).toContain("credential_schema_version");
		backup.close();
		closeDatabase(db);
	});
});

describe("process tool approval request migration", () => {
	it("accepts a migrated column appended by SQLite", () => {
		const tempRoot = mkdtempSync(path.join(tmpdir(), "leitwerk-tool-approval-migration-"));
		const sqlitePath = path.join(tempRoot, "leitwerk.sqlite");
		const seed = new DatabaseSync(sqlitePath);
		initializeSchema(seed, { sqlitePath });
		const currentSql = seed
			.prepare(
				"SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'process_tool_approval_requests'",
			)
			.get() as { sql: string };
		seed.exec("DROP TABLE process_tool_approval_requests");
		seed.exec(currentSql.sql.replace("\n\tdestination_json text,", ""));
		seed.exec(
			"CREATE UNIQUE INDEX uq_tool_approval_turn_call ON process_tool_approval_requests(instance_id, turn_record_id, tool_call_id)",
		);
		seed.exec(
			"CREATE INDEX idx_tool_approval_instance_status ON process_tool_approval_requests(instance_id, status)",
		);
		seed.close();

		const migrated = createDatabase({ sqlitePath, enableWAL: false });
		const sqlite = (migrated as unknown as { $client: DatabaseSync }).$client;
		expect(columnNames(sqlite, "process_tool_approval_requests")).toContain("destination_json");
		closeDatabase(migrated);
	});
});

describe("process question request migration", () => {
	it("backs up existing data, adds the table, and preserves requests across reopen", () => {
		const tempRoot = mkdtempSync(path.join(tmpdir(), "leitwerk-question-migration-"));
		const sqlitePath = path.join(tempRoot, "leitwerk.sqlite");
		const seed = new DatabaseSync(sqlitePath);
		seed.exec("PRAGMA foreign_keys = ON");
		initializeSchema(seed, { sqlitePath });
		insertProcess(seed, "question-process");
		seed.exec("DROP TABLE process_question_requests");
		seed.close();

		const migrated = createDatabase({ sqlitePath, enableWAL: false });
		const sqlite = (migrated as unknown as { $client: DatabaseSync }).$client;
		expect(tableNames(sqlite)).toContain("process_question_requests");
		expect(
			sqlite
				.prepare("SELECT process_id FROM process_instances WHERE id = ?")
				.get("question-process"),
		).toEqual({ process_id: "test_process" });
		insertLease(sqlite, "question-lease", "question-process");
		insertStart({
			sqlite,
			id: "question-start",
			instanceId: "question-process",
			proposedTurnRecordId: "question-turn",
		});
		insertAcceptedWorkerTurn({
			sqlite,
			id: "question-turn",
			instanceId: "question-process",
			startRecordId: "question-start",
			leaseId: "question-lease",
		});
		sqlite
			.prepare(
				`INSERT INTO process_question_requests
					(id, instance_id, turn_record_id, tool_call_id, questions_json, asked_at)
				 VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.run(
				"question-request",
				"question-process",
				"question-turn",
				"question-tool",
				JSON.stringify([
					{ id: "question_1", question: "Choose", selection: "single", options: [] },
				]),
				"2026-07-26T00:00:00.000Z",
			);
		closeDatabase(migrated);

		const reopened = createDatabase({ sqlitePath, enableWAL: false });
		const reopenedSqlite = (reopened as unknown as { $client: DatabaseSync }).$client;
		expect(
			reopenedSqlite
				.prepare(
					"SELECT status, tool_call_id AS toolCallId FROM process_question_requests WHERE id = ?",
				)
				.get("question-request"),
		).toEqual({ status: "open", toolCallId: "question-tool" });
		closeDatabase(reopened);
		expect(readdirSync(path.join(tempRoot, "backups")).some((name) => name.endsWith(".bak"))).toBe(
			true,
		);
	});

	it("removes obsolete draft state and preserves durable requests", () => {
		const tempRoot = mkdtempSync(path.join(tmpdir(), "leitwerk-question-draft-migration-"));
		const sqlitePath = path.join(tempRoot, "leitwerk.sqlite");
		const seed = new DatabaseSync(sqlitePath);
		seed.exec("PRAGMA foreign_keys = ON");
		initializeSchema(seed, { sqlitePath });
		insertProcess(seed, "question-process");
		insertLease(seed, "question-lease", "question-process");
		insertStart({
			sqlite: seed,
			id: "question-start",
			instanceId: "question-process",
			proposedTurnRecordId: "question-turn",
		});
		insertAcceptedWorkerTurn({
			sqlite: seed,
			id: "question-turn",
			instanceId: "question-process",
			startRecordId: "question-start",
			leaseId: "question-lease",
		});
		seed.exec(`
			DROP TABLE process_question_requests;
			${PROCESS_QUESTION_REQUESTS_WITH_DRAFT_STATE_SQL};
			CREATE UNIQUE INDEX uq_question_requests_turn_tool
				ON process_question_requests(instance_id, turn_record_id, tool_call_id);
			CREATE INDEX idx_question_requests_instance_status
				ON process_question_requests(instance_id, status);
			CREATE INDEX idx_question_requests_turn ON process_question_requests(turn_record_id);
		`);
		seed
			.prepare(
				`INSERT INTO process_question_requests
					(id, instance_id, turn_record_id, worker_lease_id, tool_call_id,
					 questions_json, draft_json, draft_revision, status, answers_json,
					 asked_at, answered_at, answered_by_json)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				"question-request",
				"question-process",
				"question-turn",
				"question-lease",
				"question-tool",
				JSON.stringify([{ id: "question_1", question: "Choose", selection: "single" }]),
				JSON.stringify({ question_1: "draft" }),
				2,
				"answered",
				JSON.stringify(["final"]),
				"2026-07-26T00:00:00.000Z",
				"2026-07-26T00:01:00.000Z",
				JSON.stringify({ kind: "user", id: "operator" }),
			);
		seed.close();

		const migrated = createDatabase({ sqlitePath, enableWAL: false });
		const sqlite = (migrated as unknown as { $client: DatabaseSync }).$client;
		expect(columnNames(sqlite, "process_question_requests")).not.toEqual(
			expect.arrayContaining(["worker_lease_id", "draft_json", "draft_revision"]),
		);
		expect(
			sqlite
				.prepare(
					`SELECT status, answers_json AS answersJson, answered_by_json AS answeredByJson
					 FROM process_question_requests WHERE id = ?`,
				)
				.get("question-request"),
		).toEqual({
			status: "answered",
			answersJson: JSON.stringify(["final"]),
			answeredByJson: JSON.stringify({ kind: "user", id: "operator" }),
		});
		expect(
			sqlite
				.prepare(
					"SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_question_requests_turn'",
				)
				.get(),
		).toBeUndefined();
		closeDatabase(migrated);
		expect(readdirSync(path.join(tempRoot, "backups")).some((name) => name.endsWith(".bak"))).toBe(
			true,
		);
	});

	it("rolls back the migration when foreign-key validation fails", () => {
		const tempRoot = mkdtempSync(path.join(tmpdir(), "leitwerk-question-migration-rollback-"));
		const sqlitePath = path.join(tempRoot, "leitwerk.sqlite");
		const seed = new DatabaseSync(sqlitePath);
		seed.exec("PRAGMA foreign_keys = OFF");
		initializeSchema(seed, { sqlitePath });
		seed.exec(`
			DROP TABLE process_question_requests;
			${PROCESS_QUESTION_REQUESTS_WITH_DRAFT_STATE_SQL};
		`);
		seed
			.prepare(
				`INSERT INTO process_question_requests
					(id, instance_id, turn_record_id, worker_lease_id, tool_call_id,
					 questions_json, draft_json, draft_revision, status, asked_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				"orphan-question-request",
				"missing-process",
				"missing-turn",
				"missing-lease",
				"question-tool",
				JSON.stringify([]),
				JSON.stringify({}),
				0,
				"open",
				"2026-07-26T00:00:00.000Z",
			);
		seed.close();

		expect(() => createDatabase({ sqlitePath, enableWAL: false })).toThrow(/foreign-key violation/);

		const unchanged = new DatabaseSync(sqlitePath);
		expect(columnNames(unchanged, "process_question_requests")).toEqual(
			expect.arrayContaining(["worker_lease_id", "draft_json", "draft_revision"]),
		);
		expect(
			unchanged
				.prepare("SELECT id FROM process_question_requests WHERE id = ?")
				.get("orphan-question-request"),
		).toEqual({ id: "orphan-question-request" });
		unchanged.close();
	});
});

describe("unknown schema rejection", () => {
	it("rejects an old schema without migrating, importing, backing up, or resetting it", () => {
		const tempRoot = mkdtempSync(path.join(tmpdir(), "leitwerk-old-epoch-"));
		const sqlitePath = path.join(tempRoot, "leitwerk.sqlite");
		const old = new DatabaseSync(sqlitePath);
		old.exec("CREATE TABLE process_instances (id text PRIMARY KEY, durable_marker text)");
		old.prepare("INSERT INTO process_instances VALUES ('old', 'preserve-me')").run();
		old.close();

		expect(() => createDatabase({ sqlitePath, enableWAL: false })).toThrow(
			DatabaseSchemaMismatchError,
		);
		const unchanged = new DatabaseSync(sqlitePath);
		expect(unchanged.prepare("SELECT * FROM process_instances").all()).toEqual([
			{ id: "old", durable_marker: "preserve-me" },
		]);
		expect(tableNames(unchanged)).toEqual(["process_instances"]);
		expect(existsSync(path.join(tempRoot, "backups"))).toBe(false);
		unchanged.close();
	});

	it("rejects unknown tables and index drift in an otherwise current database", () => {
		const tempRoot = mkdtempSync(path.join(tmpdir(), "leitwerk-unknown-schema-"));
		const sqlitePath = path.join(tempRoot, "leitwerk.sqlite");
		closeDatabase(createDatabase({ sqlitePath, enableWAL: false }));
		const changed = new DatabaseSync(sqlitePath);
		changed.exec("CREATE TABLE operator_unknown (id text PRIMARY KEY)");
		changed.close();
		expect(() => createDatabase({ sqlitePath, enableWAL: false })).toThrow(
			DatabaseSchemaMismatchError,
		);
	});
});

describe("server-automatic removal migration", () => {
	function restoreLegacyExecutionSchema(sqlite: DatabaseSync): void {
		for (const table of ["process_instances", "turn_records"]) {
			const { sql } = sqlite
				.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
				.get(table) as { sql: string };
			const indexes = sqlite
				.prepare(
					"SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL",
				)
				.all(table) as Array<{ sql: string }>;
			const legacySql =
				table === "process_instances"
					? sql.replace("(\n", "(\ncurrent_server_turn_record_id text,\n").replace(
							/\n\)$/,
							`,
					CONSTRAINT process_instances_one_current_execution CHECK (not ("process_instances"."current_worker_start_id" is not null and "process_instances"."current_server_turn_record_id" is not null)),
					CONSTRAINT fk_process_instances_server_turn FOREIGN KEY (id, current_server_turn_record_id) REFERENCES turn_records(instance_id, id)
				)`,
						)
					: sql.replace(
							"in ('llm', 'human', 'external', 'automatic')",
							"in ('llm', 'human', 'external', 'automatic', 'server_automatic')",
						);
			sqlite.exec(`DROP TABLE ${table}`);
			sqlite.exec(legacySql);
			for (const index of indexes) sqlite.exec(index.sql);
		}
	}

	it.each([
		false,
		true,
	])("aborts in-flight execution, converts history, and preserves unrelated data (older migrations: %s)", (olderMigrations) => {
		const tempRoot = mkdtempSync(path.join(tmpdir(), "leitwerk-server-automatic-migration-"));
		const sqlitePath = path.join(tempRoot, "leitwerk.sqlite");
		closeDatabase(createDatabase({ sqlitePath, enableWAL: false }));

		const legacy = new DatabaseSync(sqlitePath);
		restoreLegacyExecutionSchema(legacy);
		if (olderMigrations) {
			legacy.exec(`
				ALTER TABLE process_instances DROP COLUMN selected_turn_model_kind;
				ALTER TABLE process_instances DROP COLUMN launch_intent_json;
				ALTER TABLE future_executions DROP COLUMN model_profile_id;
				ALTER TABLE future_executions DROP COLUMN model_selection_kind;
				ALTER TABLE future_executions DROP COLUMN model_selection_source;
				ALTER TABLE future_executions DROP COLUMN blocked_reason_json;
				ALTER TABLE turn_records DROP COLUMN model_selection_kind;
				ALTER TABLE turn_records DROP COLUMN model_selection_source;
			`);
		}
		insertProcess(legacy, "active-server-process");
		insertProcess(legacy, "unrelated-process");
		legacy.exec(`
			INSERT INTO turn_records
				(id, instance_id, turn_id, turn_type, status, started_at)
			VALUES
				('server-running', 'active-server-process', 'deliver', 'server_automatic', 'running', '2026-08-20'),
				('server-history', 'unrelated-process', 'prepare', 'server_automatic', 'succeeded', '2026-08-19');
			UPDATE process_instances
			SET current_server_turn_record_id = 'server-running'
			WHERE id = 'active-server-process';
		`);
		legacy.close();

		const migrated = createDatabase({ sqlitePath, enableWAL: false });
		closeDatabase(migrated);
		const sqlite = new DatabaseSync(sqlitePath);
		expect(columnNames(sqlite, "process_instances")).not.toContain("current_server_turn_record_id");
		expect(
			sqlite
				.prepare("SELECT lifecycle_status, closed_at FROM process_instances WHERE id = ?")
				.get("active-server-process"),
		).toMatchObject({ lifecycle_status: "aborted", closed_at: expect.any(String) });
		expect(
			sqlite.prepare("SELECT id FROM process_instances WHERE id = ?").get("unrelated-process"),
		).toEqual({ id: "unrelated-process" });
		expect(
			sqlite
				.prepare(
					"SELECT turn_type, status, error_summary, turn_start_record_id, accepted_worker_lease_id FROM turn_records WHERE id = ?",
				)
				.get("server-running"),
		).toEqual({
			turn_type: "automatic",
			status: "failed",
			error_summary: "Server-automatic execution was removed",
			turn_start_record_id: "tsr_migrated_20260821_server-running",
			accepted_worker_lease_id: "wkr_migrated_20260821_server-running",
		});
		expect(
			sqlite
				.prepare("SELECT turn_type, status FROM turn_records WHERE id = ?")
				.get("server-history"),
		).toEqual({ turn_type: "automatic", status: "succeeded" });
		expect(readdirSync(path.join(tempRoot, "backups")).some((name) => name.endsWith(".bak"))).toBe(
			true,
		);
		sqlite.close();
	});

	it.each([
		"ALTER TABLE process_instances ADD COLUMN operator_notes text DEFAULT 'preserve me'",
		"ALTER TABLE turn_records ADD COLUMN operator_notes text DEFAULT 'preserve me'",
		"ALTER TABLE process_instances ADD COLUMN operator_constraint text CHECK (operator_constraint IS NULL)",
		"DROP INDEX idx_turn_records_status; CREATE INDEX idx_turn_records_status ON turn_records(turn_id)",
		"DROP INDEX idx_process_instances_process",
		"CREATE TRIGGER operator_trigger AFTER UPDATE ON process_instances BEGIN SELECT 1; END",
	])("rejects unknown source drift and preserves operator data: %s", (driftSql) => {
		const tempRoot = mkdtempSync(path.join(tmpdir(), "leitwerk-server-automatic-drift-"));
		const sqlitePath = path.join(tempRoot, "leitwerk.sqlite");
		closeDatabase(createDatabase({ sqlitePath, enableWAL: false }));
		const legacy = new DatabaseSync(sqlitePath);
		restoreLegacyExecutionSchema(legacy);
		insertProcess(legacy, "operator-process");
		legacy.exec(`
			INSERT INTO turn_records (id, instance_id, turn_id, turn_type, status, started_at)
			VALUES ('operator-turn', 'operator-process', 'deliver', 'server_automatic', 'running', '2026-08-20');
			UPDATE process_instances SET current_server_turn_record_id = 'operator-turn';
		`);
		legacy.exec(driftSql);
		const beforeSchema = legacy
			.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name")
			.all();
		const beforeProcesses = legacy.prepare("SELECT * FROM process_instances").all();
		const beforeTurns = legacy.prepare("SELECT * FROM turn_records").all();
		legacy.close();

		expect(() => createDatabase({ sqlitePath, enableWAL: false })).toThrow(
			DatabaseSchemaMismatchError,
		);
		const preserved = new DatabaseSync(sqlitePath);
		expect(
			preserved.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all(),
		).toEqual(beforeSchema);
		expect(preserved.prepare("SELECT * FROM process_instances").all()).toEqual(beforeProcesses);
		expect(preserved.prepare("SELECT * FROM turn_records").all()).toEqual(beforeTurns);
		expect(preserved.prepare("SELECT * FROM worker_leases").all()).toEqual([]);
		expect(preserved.prepare("SELECT * FROM turn_start_records").all()).toEqual([]);
		preserved.close();
	});
});

describe("execution lineage constraints", () => {
	it("rejects execution pointers to another process", () => {
		const sqlite = openBaseline();
		insertProcess(sqlite, "p1");
		insertProcess(sqlite, "p2");
		insertStart({ sqlite, id: "start2", instanceId: "p2", proposedTurnRecordId: "turn2" });
		expect(() =>
			sqlite
				.prepare("UPDATE process_instances SET current_worker_start_id = 'start2' WHERE id = 'p1'")
				.run(),
		).toThrow(/FOREIGN KEY constraint/);
		sqlite.close();
	});

	it("accepts one correctly reserved worker record and rejects reserved-id, turn, instance, and lease mismatches", () => {
		const sqlite = openBaseline();
		insertProcess(sqlite, "p1");
		insertProcess(sqlite, "p2");
		insertLease(sqlite, "lease1", "p1");
		insertLease(sqlite, "lease2", "p2");
		insertStart({
			sqlite,
			id: "start1",
			instanceId: "p1",
			proposedTurnRecordId: "reserved1",
			turnId: "generate",
		});

		for (const values of [
			["wrong-id", "p1", "generate", "start1", "lease1"],
			["reserved1", "p1", "wrong-turn", "start1", "lease1"],
			["reserved1", "p2", "generate", "start1", "lease2"],
			["reserved1", "p1", "generate", "start1", "lease2"],
		] as const) {
			expect(() =>
				insertAcceptedWorkerTurn({
					sqlite,
					id: values[0],
					instanceId: values[1],
					turnId: values[2],
					startRecordId: values[3],
					leaseId: values[4],
				}),
			).toThrow(/FOREIGN KEY constraint/);
		}

		insertAcceptedWorkerTurn({
			sqlite,
			id: "reserved1",
			instanceId: "p1",
			startRecordId: "start1",
			leaseId: "lease1",
		});
		expect(() =>
			insertAcceptedWorkerTurn({
				sqlite,
				id: "reserved1",
				instanceId: "p1",
				startRecordId: "start1",
				leaseId: "lease1",
			}),
		).toThrow();
		sqlite.close();
	});

	it("requires start and lease links for worker-owned turns and rejects removed turn types", () => {
		const sqlite = openBaseline();
		insertProcess(sqlite, "p1");
		expect(() =>
			sqlite
				.prepare(
					"INSERT INTO turn_records (id, instance_id, turn_id, turn_type, status, started_at) VALUES ('worker', 'p1', 'generate', 'llm', 'running', '2026-07-22')",
				)
				.run(),
		).toThrow(/CHECK constraint/);
		for (const [id, turnType] of [
			["automatic", "automatic"],
			["removed", "server_automatic"],
		] as const) {
			expect(() =>
				sqlite
					.prepare(
						"INSERT INTO turn_records (id, instance_id, turn_id, turn_type, status, started_at) VALUES (?, 'p1', 'server', ?, 'running', '2026-07-22')",
					)
					.run(id, turnType),
			).toThrow(/CHECK constraint/);
		}
		sqlite.close();
	});

	it("rejects invalid start state kinds and duplicate reserved ids", () => {
		const sqlite = openBaseline();
		insertProcess(sqlite, "p1");
		expect(() =>
			sqlite
				.prepare(
					`INSERT INTO turn_start_records
						(id, instance_id, turn_id, turn_type, proposed_turn_record_id, start_kind, state_json, created_at, updated_at)
					 VALUES ('bad', 'p1', 'generate', 'llm', 'bad-turn', 'selected_turn', '{"kind":"unknown"}', '2026-07-22', '2026-07-22')`,
				)
				.run(),
		).toThrow(/CHECK constraint/);
		insertStart({ sqlite, id: "start1", instanceId: "p1", proposedTurnRecordId: "reserved" });
		expect(() =>
			insertStart({ sqlite, id: "start2", instanceId: "p1", proposedTurnRecordId: "reserved" }),
		).toThrow(/UNIQUE constraint/);
		sqlite.close();
	});
});
