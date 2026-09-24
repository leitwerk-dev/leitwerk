import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	bindExternalWrites,
	ExternalWriteMissingRemoteError,
} from "@leitwerk-dev/external-writes/internal";
import { expect, it } from "vitest";
import { createOwnedDatabaseScope } from "../test-helpers/owned-test-deps.js";
import { closeDatabase } from "./database.js";
import { createAllRepos } from "./repositories.js";

const { createDatabase, closeOwnedSqlite } = createOwnedDatabaseScope();

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
		expect(
			await bindExternalWrites(repos.externalWrites, process.id).ensure(identity, operation),
		).toEqual(remote);
		closeDatabase(db);
		db = createDatabase({ sqlitePath });
		const reopened = createAllRepos(db);
		expect(reopened.externalWrites.listByInstance(process.id)).toMatchObject([
			{ dedupKey: "ticket:1", metadata: { externalId: "42", url: "https://example.test/42" } },
		]);
		expect(
			await bindExternalWrites(reopened.externalWrites, process.id).ensure(identity, operation),
		).toMatchObject(remote);
		remote = null;
		await expect(
			bindExternalWrites(reopened.externalWrites, process.id).ensure(identity, operation),
		).rejects.toBeInstanceOf(ExternalWriteMissingRemoteError);
		expect(creations).toBe(1);
	} finally {
		closeOwnedSqlite();
		rmSync(root, { recursive: true, force: true });
	}
});
