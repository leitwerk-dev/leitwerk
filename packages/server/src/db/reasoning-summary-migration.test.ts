import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { closeDatabase, createDatabase, initializeSchema } from "./database.js";
import { createAllRepos } from "./repositories.js";

function makeLegacy(db: ReturnType<typeof createDatabase>) {
	db.$client.exec(`DROP TABLE turn_summaries; DROP TABLE session_summaries;
 CREATE TEMP TABLE saved_events AS SELECT id, instance_id, event_type, data, created_at FROM process_events ORDER BY event_sequence;
 DROP TABLE process_events;
 CREATE TABLE process_events (id text PRIMARY KEY NOT NULL, instance_id text NOT NULL REFERENCES process_instances(id) ON DELETE CASCADE, event_type text NOT NULL, data text NOT NULL DEFAULT '{}', created_at text NOT NULL);
 INSERT INTO process_events SELECT * FROM saved_events; DROP TABLE saved_events;
 CREATE INDEX idx_process_events_instance ON process_events(instance_id);
 CREATE INDEX idx_process_events_instance_created ON process_events(instance_id, created_at);
 CREATE INDEX idx_process_events_type ON process_events(event_type);`);
}

describe("reasoning summary migration", () => {
	it.each([
		"startup",
		"operator SQL",
	])("preserves file-backed data and equal-timestamp ingestion order with %s", (mode) => {
		const root = mkdtempSync(join(tmpdir(), "leitwerk-summary-migration-"));
		const sqlitePath = join(root, "state.sqlite");
		try {
			let db = createDatabase({ sqlitePath });
			let repos = createAllRepos(db);
			const process = repos.processes.create({
				processId: "test",
				stateJson: '{"workspace":"retained"}',
			});
			repos.events.create({
				instanceId: process.id,
				eventType: "pi.stream.delta",
				data: { turnRecordId: "turn", streamType: "thinking", text: "first" },
			});
			repos.events.create({
				instanceId: process.id,
				eventType: "pi.stream.delta",
				data: { turnRecordId: "turn", streamType: "thinking", text: "second" },
			});
			db.$client.exec("UPDATE process_events SET created_at = '2026-09-09T00:00:00.000Z'");
			makeLegacy(db);
			if (mode === "operator SQL") {
				db.$client.exec(
					readFileSync(
						new URL("../../migrations/20260909_add_reasoning_summaries.sql", import.meta.url),
						"utf8",
					),
				);
				initializeSchema(db.$client);
			}
			closeDatabase(db);
			db = createDatabase({ sqlitePath });
			repos = createAllRepos(db);
			expect(repos.processes.getById(process.id)?.stateJson).toBe('{"workspace":"retained"}');
			const events = repos.events.listByTurnRecord(process.id, "turn");
			expect(events.map((event) => event.data.text)).toEqual(["first", "second"]);
			expect(events.map((event) => event.eventSequence)).toEqual([1, 2]);
			const third = repos.events.create({
				instanceId: process.id,
				eventType: "pi.usage",
				data: { turnRecordId: "turn", input: 7, output: 3 },
			});
			expect(third.eventSequence).toBe(3);
			const summary = repos.turnSummaries.get("turn");
			closeDatabase(db);
			db = createDatabase({ sqlitePath });
			expect(createAllRepos(db).turnSummaries.get("turn")).toEqual(summary);
			if (mode === "startup")
				expect(readdirSync(join(root, "backups")).some((name) => name.endsWith(".bak"))).toBe(true);
			closeDatabase(db);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
