import { DatabaseSync } from "node:sqlite";
import { onTestFinished } from "vitest";
import { closeDatabase, createDatabase, createInMemoryDatabase } from "../db/database.js";
import { createTestDeps } from "./unit-deps.js";

/** Creates repositories whose database is owned by the current test. @internal */
export function createOwnedTestDeps(...args: Parameters<typeof createTestDeps>) {
	const deps = createTestDeps(...args);
	onTestFinished(() => closeDatabase(deps.db));
	return deps;
}

/** Creates an in-memory database owned by the current test. @internal */
export function createOwnedInMemoryDatabase(...args: Parameters<typeof createInMemoryDatabase>) {
	const db = createInMemoryDatabase(...args);
	onTestFinished(() => {
		if (db.$client.isOpen) db.$client.close();
	});
	return db;
}

/** Tracks file handles so tests can close them before removing storage. @internal */
export function createOwnedDatabaseScope() {
	const handles = new Set<DatabaseSync>();
	function closeOwnedSqlite() {
		for (const db of handles) if (db.isOpen) db.close();
		handles.clear();
	}
	function own(sqlite: DatabaseSync) {
		handles.add(sqlite);
		onTestFinished(closeOwnedSqlite);
		return sqlite;
	}
	return {
		closeOwnedSqlite,
		createDatabase(...args: Parameters<typeof createDatabase>) {
			const db = createDatabase(...args);
			own(db.$client);
			return db;
		},
		openOwnedSqlite(...args: ConstructorParameters<typeof DatabaseSync>) {
			return own(new DatabaseSync(...args));
		},
	};
}
