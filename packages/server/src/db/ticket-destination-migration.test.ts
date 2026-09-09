import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { closeDatabase, createDatabase, initializeSchema } from "./database.js";
import { createAllRepos } from "./repositories.js";

describe("ticket destination history compatibility", () => {
	for (const retainedHistory of [false, true]) {
		it(`preserves process data with ${retainedHistory ? "retained" : "missing"} destination history`, () => {
			const root = mkdtempSync(path.join(tmpdir(), "leitwerk-ticket-history-"));
			const sqlitePath = path.join(root, "leitwerk.sqlite");
			try {
				const seed = new DatabaseSync(sqlitePath);
				initializeSchema(seed, { sqlitePath });
				seed.exec(`
					INSERT INTO process_instances (id, process_id, created_at, updated_at)
					VALUES ('preserved', 'test_process', '2026-08-23', '2026-08-23');
					DROP TABLE ticket_destination_recents;
				`);
				if (retainedHistory) {
					// Schema shipped by the retained destination-selection feature.
					seed.exec(`
						CREATE TABLE ticket_destination_recents (
							id text PRIMARY KEY NOT NULL, actor_key text NOT NULL,
							tool_name text NOT NULL, destination_id text NOT NULL,
							created_at text NOT NULL, updated_at text NOT NULL
						);
						CREATE INDEX idx_ticket_destination_recents_actor_tool
							ON ticket_destination_recents(actor_key, tool_name, updated_at);
						CREATE UNIQUE INDEX uq_ticket_destination_recent
							ON ticket_destination_recents(actor_key, tool_name, destination_id);
						INSERT INTO ticket_destination_recents
						VALUES ('tdr_saved', 'oidc:alice', 'tracker_create_ticket', 'repo-1',
							'2026-08-23', '2026-08-23');
					`);
				}
				seed.close();
				for (let restart = 0; restart < 2; restart++) {
					const db = createDatabase({ sqlitePath, enableWAL: false });
					try {
						const repos = createAllRepos(db);
						expect(repos.processes.getById("preserved")?.id).toBe("preserved");
						expect(
							repos.ticketDestinationRecents
								.list("oidc:alice", "tracker_create_ticket")
								.map((entry) => entry.destinationId),
						).toEqual(retainedHistory ? ["repo-1"] : []);
					} finally {
						closeDatabase(db);
					}
				}
				if (!retainedHistory) {
					const backups = readdirSync(path.join(root, "backups")).filter((name) =>
						name.endsWith(".bak"),
					);
					expect(backups).toHaveLength(1);
					const backup = new DatabaseSync(path.join(root, "backups", backups[0]), {
						readOnly: true,
					});
					try {
						expect(backup.prepare("SELECT id FROM process_instances").all()).toEqual([
							{ id: "preserved" },
						]);
						expect(
							backup
								.prepare("SELECT name FROM sqlite_master WHERE name = 'ticket_destination_recents'")
								.get(),
						).toBeUndefined();
					} finally {
						backup.close();
					}
				}
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		});
	}
});
