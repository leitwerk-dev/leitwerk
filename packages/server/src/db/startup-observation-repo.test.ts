import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { closeDatabase, createDatabase, initializeSchema } from "./database.js";
import { createAllRepos } from "./repositories.js";

it("migrates file storage without rewriting existing durable tables and retains first evidence", () => {
	const root = mkdtempSync(join(tmpdir(), "startup-migration-"));
	const sqlitePath = join(root, "state.sqlite");
	try {
		const sqlite = new DatabaseSync(sqlitePath);
		initializeSchema(sqlite, { sqlitePath });
		sqlite.exec(
			"INSERT INTO process_instances(id, process_id, created_at, updated_at) VALUES ('p', 'test', '2026-09-11', '2026-09-11'); DROP TABLE startup_observations;",
		);
		const before = sqlite.prepare("SELECT * FROM process_instances").all();
		sqlite.close();
		const db = createDatabase({ sqlitePath });
		const repos = createAllRepos(db);
		const lease = repos.leases.create({ instanceId: "p", workerId: "w", state: "spawning" });
		const observation = {
			workerLeaseId: lease.id,
			milestone: "pod_requested" as const,
			observedAt: "2026-09-11T10:00:00.123Z",
			sourceAt: null,
			sourceKind: "server" as const,
			objectUid: null,
			turnRecordId: null,
			notBefore: null,
			metadata: {},
		};
		expect(repos.startupObservations.record({ ...observation, observedAt: "invalid" })).toBe(false);
		expect(repos.startupObservations.record(observation)).toBe(true);
		expect(
			repos.startupObservations.record({ ...observation, observedAt: "2026-09-11T11:00:00Z" }),
		).toBe(false);
		closeDatabase(db);
		const reopened = createDatabase({ sqlitePath });
		expect(createAllRepos(reopened).startupObservations.listByLease(lease.id)).toEqual([
			observation,
		]);
		closeDatabase(reopened);
		const check = new DatabaseSync(sqlitePath);
		expect(check.prepare("SELECT * FROM process_instances").all()).toEqual(before);
		check.close();
		expect(readdirSync(join(root, "backups")).filter((name) => name.endsWith(".bak"))).toHaveLength(
			1,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
