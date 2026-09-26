import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADMIN_ACTOR } from "@leitwerk-dev/domain";
import { expect, it } from "vitest";
import { createOwnedDatabaseScope } from "../test-helpers/owned-test-deps.js";
import { createSettingsFixture, instructions } from "../test-helpers/scoped-settings-fixtures.js";
import { closeDatabase, initializeSchema } from "./database.js";
import { createAllRepos } from "./repositories.js";

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
			key: instructions.key,
			value: "Keep this",
			mode: "replace",
			reset: false,
			expectedRevision: 0,
			actor: ADMIN_ACTOR,
		});
		closeDatabase(db);
		db = createDatabase({ sqlitePath: path });
		const restarted = await createSettingsFixture(createAllRepos(db));
		expect(restarted.settings.resolve(instructions, {}).value).toBe("Keep this");
		expect(restarted.repos.processes.getById(process.id)?.stateJson).toBe('{"tree":"retained"}');
		expect(restarted.repos.scopedSettings.getOverride("instance", instructions.key)).toMatchObject({
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
