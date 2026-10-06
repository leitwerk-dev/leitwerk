import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { closeDatabase, createDatabase } from "./database.js";
import { createAllRepos } from "./repositories.js";

it("adds history indexes to retained file-backed data and only repairs missing summaries", () => {
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
		for (const name of [
			"idx_turn_records_page",
			"idx_turn_annotations_created",
			"idx_worker_leases_started",
			"idx_worker_leases_exited",
			"idx_leaf_outcomes_anchored",
		])
			db.$client.exec(`DROP INDEX ${name}`);
		closeDatabase(db);
		db = createDatabase({ sqlitePath });
		repos = createAllRepos(db);
		expect(repos.turnRecords.getById(turn.id)?.turnResultMarkdown).toBe("Retained result");
		expect(repos.turnRecords.listMissingSummaries(process.id)).toEqual([]);
		expect(readdirSync(join(root, "backups")).some((name) => name.endsWith(".bak"))).toBe(true);
		expect(db.$client.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
	} finally {
		closeDatabase(db);
		rmSync(root, { recursive: true, force: true });
	}
});
