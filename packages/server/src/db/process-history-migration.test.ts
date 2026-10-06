import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { closeDatabase, createDatabase } from "./database.js";
import { createAllRepos } from "./repositories.js";

it.each([
	`DROP INDEX idx_turn_records_page;
DROP INDEX idx_turn_annotations_created;
DROP INDEX idx_worker_leases_started;
DROP INDEX idx_worker_leases_exited;`,
	"CREATE INDEX idx_leaf_outcomes_anchored ON process_leaf_outcome_snapshots(instance_id, anchored_at)",
])("migrates retained file-backed history (%#)", (upgrade) => {
	const root = mkdtempSync(join(tmpdir(), "leitwerk-history-migration-"));
	const sqlitePath = join(root, "state.sqlite");
	let db = createDatabase({ sqlitePath });
	try {
		let repos = createAllRepos(db);
		const process = repos.processes.create({ processId: "retained" });
		const turn = repos.turnRecords.create({
			instanceId: process.id,
			turnId: "review",
			turnType: "human",
			turnResultMarkdown: "Retained result",
		});
		expect(repos.turnRecords.listMissingSummaries(process.id).map((t) => t.id)).toEqual([turn.id]);
		repos.events.create({
			instanceId: process.id,
			eventType: "turn.progress",
			data: { turnRecordId: turn.id },
		});
		db.$client.exec(upgrade);
		closeDatabase(db);
		db = createDatabase({ sqlitePath });
		repos = createAllRepos(db);
		expect(repos.turnRecords.getById(turn.id)?.turnResultMarkdown).toBe("Retained result");
		expect(repos.turnRecords.listMissingSummaries(process.id)).toEqual([]);
		expect(readdirSync(join(root, "backups")).some((name) => name.endsWith(".bak"))).toBe(true);
		expect(db.$client.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
		expect(db.$client.prepare("PRAGMA index_info(idx_leaf_outcomes_anchored)").all()).toEqual([]);
	} finally {
		closeDatabase(db);
		rmSync(root, { recursive: true, force: true });
	}
});
