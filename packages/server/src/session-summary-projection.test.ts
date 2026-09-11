import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { closeDatabase, createDatabase } from "./db/database.js";
import { createAllRepos } from "./db/repositories.js";
import { createFileBackedProcessSessionSnapshotStore } from "./process-session-store.js";
import { createProjectedSessionSnapshotStore } from "./session-summary-projection.js";

it("persists session projections across restart and repairs a crash between snapshot replacement and projection", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "leitwerk-session-summary-"));
	const sqlitePath = path.join(root, "state.sqlite");
	let db = createDatabase({ sqlitePath });
	try {
		let repos = createAllRepos(db);
		const process = repos.processes.create({ processId: "test" });
		const source = createFileBackedProcessSessionSnapshotStore(path.join(root, "trees"));
		const snapshot = (prompt: string) =>
			[
				{
					type: "session",
					version: 3,
					id: "session",
					timestamp: "2026-09-09T00:00:00Z",
					cwd: "/retained/workspace",
				},
				{
					type: "message",
					id: "root",
					parentId: null,
					timestamp: "2026-09-09T00:00:00Z",
					message: { role: "user", content: prompt },
				},
				...Array.from({ length: 1500 }, (_, index) => ({
					type: "message",
					id: `assistant-${index}`,
					parentId: index === 0 ? "root" : `assistant-${index - 1}`,
					timestamp: "2026-09-09T00:00:01Z",
					message: {
						role: "assistant",
						content: [{ type: "thinking", thinking: "retained reasoning ".repeat(100) }],
					},
				})),
			]
				.map((entry) => JSON.stringify(entry))
				.join("\n");
		await createProjectedSessionSnapshotStore(source, repos).writeSnapshot(
			process.id,
			snapshot("original prompt"),
		);
		const original = repos.turnSummaries.getSession(process.id);
		expect(original?.prompt.text).toBe("original prompt");
		expect(JSON.stringify(original).length).toBeLessThan(2000);
		closeDatabase(db);
		db = createDatabase({ sqlitePath });
		repos = createAllRepos(db);
		let fullReads = 0;
		const observedSource = {
			...source,
			async readSnapshotHandle(instanceId: string) {
				const handle = await source.readSnapshotHandle(instanceId);
				return (
					handle && {
						signature: handle.signature,
						load: () => {
							fullReads++;
							return handle.load();
						},
					}
				);
			},
		};
		const restarted = createProjectedSessionSnapshotStore(observedSource, repos);
		await restarted.backfill(process.id);
		expect(fullReads).toBe(0);
		expect(repos.turnSummaries.getSession(process.id)).toEqual(original);
		await source.writeSnapshot(process.id, snapshot("replaced prompt"));
		await restarted.backfill(process.id);
		expect(fullReads).toBe(1);
		expect(repos.turnSummaries.getSession(process.id)?.prompt.text).toBe("replaced prompt");
		expect(await source.readRawSnapshot(process.id)).toContain("retained reasoning");
	} finally {
		closeDatabase(db);
		await rm(root, { recursive: true, force: true });
	}
});
