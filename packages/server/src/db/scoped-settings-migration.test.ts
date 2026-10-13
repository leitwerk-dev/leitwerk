import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADMIN_ACTOR } from "@leitwerk-dev/domain";
import { expect, it } from "vitest";
import { createOwnedDatabaseScope } from "../test-helpers/owned-test-deps.js";
import { createTestTurnStart } from "../test-helpers/process-model-fixtures.js";
import {
	createSettingsFixture,
	reportLabel,
	repositoryLabel,
} from "../test-helpers/scoped-settings-fixtures.js";
import { closeDatabase, initializeSchema } from "./database.js";
import { createAllRepos } from "./repositories.js";

it.each([
	"startup",
	"operator SQL",
])("removes retired repository instruction overrides with %s while preserving process history and other settings", async (mode) => {
	const { createDatabase, closeOwnedSqlite } = createOwnedDatabaseScope();
	const directory = mkdtempSync(join(tmpdir(), "leitwerk-retired-instructions-"));
	const path = join(directory, "state.sqlite");
	try {
		let db = createDatabase({ sqlitePath: path });
		const fixture = await createSettingsFixture(createAllRepos(db));
		const repository = fixture.settings.discover({
			scopeType: "repository",
			identity: "repo",
			label: "Repository",
		});
		for (const subjectId of ["instance", repository.id])
			fixture.repos.scopedSettings.write({
				subjectId,
				key: "coding.repository_instructions",
				value: "Retired instruction",
				mode: "append",
				reset: false,
				expectedRevision: 0,
				schemaVersion: 1,
				actor: ADMIN_ACTOR,
			});
		fixture.settings.write({
			subjectId: "instance",
			key: reportLabel.key,
			value: "Retained label",
			reset: false,
			expectedRevision: 0,
			actor: ADMIN_ACTOR,
		});
		const process = fixture.repos.processes.create({
			processId: "settings_process",
			selectedTurnId: "run",
			stateJson: '{"retained":true}',
		});
		const template = createTestTurnStart({ instanceId: process.id });
		if (template.state.kind !== "starting" || template.state.start.kind !== "llm")
			throw new Error("Expected LLM start");
		const captured = fixture.settings.capture(process, "run");
		if (!captured) throw new Error("Expected captured settings");
		const historicalSettings = {
			...captured,
			instructions: [
				{
					label: "Repository",
					setting: {
						key: "coding.repository_instructions",
						value: "Retired instruction",
						sources: [],
					},
				},
			],
		};
		const start = fixture.repos.turnStarts.create({
			...template,
			state: {
				kind: "starting",
				start: { ...template.state.start, scopedSettings: historicalSettings },
			},
		});
		const retained = fixture.repos.scopedSettings.getOverride("instance", reportLabel.key);
		if (mode === "operator SQL")
			db.$client.exec(
				readFileSync(
					new URL(
						"../../migrations/20261008_remove_repository_instruction_overrides.sql",
						import.meta.url,
					),
					"utf8",
				),
			);
		closeDatabase(db);
		db = createDatabase({ sqlitePath: path });
		const repos = createAllRepos(db);
		expect(repos.scopedSettings.listOverrides().map((row) => row.key)).toEqual([reportLabel.key]);
		expect(repos.scopedSettings.getOverride("instance", reportLabel.key)).toEqual(retained);
		expect(repos.turnStarts.getById(start.id)).toEqual(start);
		expect(repos.processes.getById(process.id)?.stateJson).toBe(process.stateJson);
		expect(repos.scopedSettings.getSubject(repository.id)).toEqual(repository);
		const backups = mode === "startup" ? readdirSync(join(directory, "backups")) : [];
		if (mode === "startup") expect(backups.some((name) => name.endsWith(".bak"))).toBe(true);
		closeDatabase(db);
		db = createDatabase({ sqlitePath: path });
		expect(createAllRepos(db).turnStarts.getById(start.id)).toEqual(start);
		if (mode === "startup") expect(readdirSync(join(directory, "backups"))).toEqual(backups);
	} finally {
		closeOwnedSqlite();
		rmSync(directory, { recursive: true, force: true });
	}
});

it.each([
	"startup",
	"operator SQL",
])("migrates settings with %s and retains data across restart", async (mode) => {
	const { createDatabase, closeOwnedSqlite } = createOwnedDatabaseScope();
	const directory = mkdtempSync(join(tmpdir(), "leitwerk-settings-"));
	const path = join(directory, "state.sqlite");
	try {
		let db = createDatabase({ sqlitePath: path });
		const process = createAllRepos(db).processes.create({
			processId: "retained",
			stateJson: '{"tree":"retained"}',
		});
		db.$client.exec(
			"DROP TABLE settings_overrides; DROP TABLE settings_aliases; DROP TABLE settings_subjects",
		);
		if (mode === "operator SQL") {
			db.$client.exec(
				readFileSync(
					new URL("../../migrations/20260926_add_scoped_settings.sql", import.meta.url),
					"utf8",
				),
			);
			initializeSchema(db.$client);
		}
		closeDatabase(db);
		db = createDatabase({ sqlitePath: path });
		const { settings } = await createSettingsFixture(createAllRepos(db));
		settings.write({
			subjectId: "instance",
			key: reportLabel.key,
			value: "Keep this",
			mode: "replace",
			reset: false,
			expectedRevision: 0,
			actor: ADMIN_ACTOR,
		});
		closeDatabase(db);
		db = createDatabase({ sqlitePath: path });
		const restarted = await createSettingsFixture(createAllRepos(db));
		expect(restarted.settings.resolve(reportLabel, {}).value).toBe("Keep this");
		expect(restarted.repos.processes.getById(process.id)?.stateJson).toBe('{"tree":"retained"}');
		expect(restarted.repos.scopedSettings.getOverride("instance", reportLabel.key)).toMatchObject({
			revision: 1,
			actor: ADMIN_ACTOR,
		});
		if (mode === "startup")
			expect(readdirSync(join(directory, "backups")).some((name) => name.endsWith(".bak"))).toBe(
				true,
			);
	} finally {
		closeOwnedSqlite();
		rmSync(directory, { recursive: true, force: true });
	}
});

it.each([
	"startup",
	"operator SQL",
])("migrates subject redirects with %s and preserves merged settings and history after restart", async (mode) => {
	const { createDatabase, closeOwnedSqlite } = createOwnedDatabaseScope();
	const directory = mkdtempSync(join(tmpdir(), "leitwerk-settings-redirects-"));
	const path = join(directory, "state.sqlite");
	try {
		let db = createDatabase({ sqlitePath: path });
		const fixture = await createSettingsFixture(createAllRepos(db));
		const aliases = ["git@example.org:team/repo.git", "https://example.org/team/repo.git"];
		const subjects = aliases.map((alias) =>
			fixture.settings.discover({
				scopeType: "repository",
				identity: `locator:${alias}`,
				label: alias,
				aliases: [alias],
			}),
		);
		for (const subject of subjects)
			fixture.settings.write({
				subjectId: subject.id,
				key: repositoryLabel.key,
				value: "Retained guidance",
				mode: "replace",
				reset: false,
				expectedRevision: 0,
				actor: ADMIN_ACTOR,
			});
		const process = fixture.repos.processes.create({
			processId: "settings_process",
			selectedTurnId: "run",
		});
		fixture.repos.projects.create({
			instanceId: process.id,
			key: "repo",
			repoLocator: aliases[0],
			baseBranch: "main",
		});
		const template = createTestTurnStart({ instanceId: process.id });
		if (template.state.kind !== "starting" || template.state.start.kind !== "llm")
			throw new Error("Expected LLM start");
		const captured = fixture.repos.turnStarts.create({
			...template,
			state: {
				kind: "starting",
				start: {
					...template.state.start,
					scopedSettings: fixture.settings.capture(process, "run"),
				},
			},
		});
		db.$client.exec("DROP TABLE settings_subject_redirects");
		if (mode === "operator SQL")
			db.$client.exec(
				readFileSync(
					new URL("../../migrations/20260926_add_settings_subject_redirects.sql", import.meta.url),
					"utf8",
				),
			);
		closeDatabase(db);
		db = createDatabase({ sqlitePath: path });
		const migrated = await createSettingsFixture(createAllRepos(db));
		const merged = migrated.settings.discover({
			scopeType: "repository",
			identity: 'provider:["https://example.org","42"]',
			label: "team/repo",
			aliases,
		});
		closeDatabase(db);
		db = createDatabase({ sqlitePath: path });
		const restarted = await createSettingsFixture(createAllRepos(db));
		for (const subject of subjects) {
			expect(restarted.repos.scopedSettings.getSubject(subject.id)?.id).toBe(merged.id);
			expect(restarted.settings.resolve(repositoryLabel, { repository: subject.id }).value).toBe(
				"Retained guidance",
			);
			expect(
				restarted.repos.scopedSettings.getOverride(subject.id, repositoryLabel.key),
			).toMatchObject({ actor: ADMIN_ACTOR, revision: 2 });
		}
		expect(restarted.repos.turnStarts.getById(captured.id)).toEqual(captured);
		expect(restarted.repos.projects.listByInstance(process.id)).toHaveLength(1);
		if (mode === "startup")
			expect(readdirSync(join(directory, "backups")).some((name) => name.endsWith(".bak"))).toBe(
				true,
			);
	} finally {
		closeOwnedSqlite();
		rmSync(directory, { recursive: true, force: true });
	}
});
