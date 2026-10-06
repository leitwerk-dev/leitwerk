import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { commitWrites, deriveReactions } from "../process-engine/writes/commit-writes.js";
import { createWrites } from "../process-engine/writes/writes.js";
import { closeDatabase, createDatabase } from "./database.js";
import { createAllRepos } from "./repositories.js";

it("persists scheduling without activity or list movement across file-backed restarts", () => {
	const root = mkdtempSync(join(tmpdir(), "process-activity-"));
	const sqlitePath = join(root, "state.sqlite");
	let db = createDatabase({ sqlitePath });
	try {
		let repos = createAllRepos(db);
		const waiting = repos.processes.create({ processId: "waiting", lifecycleStatus: "waiting" });
		const other = repos.processes.create({ processId: "other" });
		const timestamp = "2000-01-01T00:00:00.000Z";
		db.$client
			.prepare("UPDATE process_instances SET updated_at = ? WHERE id = ?")
			.run(timestamp, waiting.id);
		db.$client
			.prepare("UPDATE process_instances SET updated_at = ? WHERE id = ?")
			.run("2001-01-01T00:00:00.000Z", other.id);
		for (let revision = 1; revision <= 5; revision++) {
			const writes = createWrites({
				processPatch: { metadata: { revision, nextCheckAt: revision * 30_000 } },
				changedFields: ["metadata"],
				preserveUpdatedAt: true,
			});
			const commit = commitWrites(repos, waiting.id, writes);
			expect(commit.processAfter?.updatedAt).toBe(timestamp);
			expect(deriveReactions(commit, writes)).toContainEqual(
				expect.objectContaining({
					kind: "broadcast",
					frame: expect.objectContaining({
						type: "process.updated",
						payload: {
							process: {
								metadata: { revision, nextCheckAt: revision * 30_000 },
								updatedAt: timestamp,
							},
							changedFields: ["metadata"],
						},
					}),
				}),
			);
			expect(repos.processes.listAll().map((p) => p.id)).toEqual([other.id, waiting.id]);
		}
		closeDatabase(db);
		db = createDatabase({ sqlitePath });
		repos = createAllRepos(db);
		expect(repos.processes.getById(waiting.id)).toMatchObject({
			updatedAt: timestamp,
			metadata: { revision: 5 },
		});
		const writes = createWrites({
			processPatch: { stateJson: '{"status":"new evidence"}' },
			changedFields: ["stateJson"],
		});
		const commit = commitWrites(repos, waiting.id, writes);
		expect(commit.processAfter?.updatedAt).not.toBe(timestamp);
		expect(repos.processes.listAll().map((p) => p.id)).toEqual([waiting.id, other.id]);
		expect(deriveReactions(commit, writes)).toContainEqual(
			expect.objectContaining({
				kind: "broadcast",
				frame: expect.objectContaining({
					type: "process.updated",
					payload: expect.objectContaining({ changedFields: ["stateJson", "updatedAt"] }),
				}),
			}),
		);
	} finally {
		closeDatabase(db);
		rmSync(root, { recursive: true, force: true });
	}
});
