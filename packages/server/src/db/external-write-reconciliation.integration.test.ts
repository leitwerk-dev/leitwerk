import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ExternalWriteMissingRemoteError,
	ensureWrite,
} from "@leitwerk-dev/external-writes/internal";
import { expect, it } from "vitest";
import { closeDatabase, createDatabase } from "./database.js";
import { createAllRepos } from "./repositories.js";

it("retains receipts after reopening SQLite and never recreates a logged remote object", async () => {
	const root = mkdtempSync(join(tmpdir(), "external-write-"));
	const sqlitePath = join(root, "state.sqlite");
	let db = createDatabase({ sqlitePath });
	try {
		const repos = createAllRepos(db);
		const process = repos.processes.create({ processId: "test" });
		const identity = { writeType: "test.ticket", dedupKey: "ticket:1" };
		let remote: { id: string; url: string } | null = null;
		let creations = 0;
		const operation = {
			mode: "reconcile" as const,
			reconcile: async () => remote,
			execute: async () => {
				creations++;
				remote = { id: "42", url: "https://example.test/42" };
				throw new Error("response lost");
			},
			toMetadata: (value: { id: string; url: string }) => ({
				externalId: value.id,
				url: value.url,
			}),
		};
		expect(await ensureWrite(repos.externalWrites, process.id, identity, operation)).toEqual(
			remote,
		);
		closeDatabase(db);
		db = createDatabase({ sqlitePath });
		const reopened = createAllRepos(db);
		expect(reopened.externalWrites.listByInstance(process.id)).toMatchObject([
			{ dedupKey: "ticket:1", metadata: { externalId: "42", url: "https://example.test/42" } },
		]);
		expect(
			await ensureWrite(reopened.externalWrites, process.id, identity, operation),
		).toMatchObject(remote);
		remote = null;
		await expect(
			ensureWrite(reopened.externalWrites, process.id, identity, operation),
		).rejects.toBeInstanceOf(ExternalWriteMissingRemoteError);
		expect(creations).toBe(1);
	} finally {
		closeDatabase(db);
		rmSync(root, { recursive: true, force: true });
	}
});
